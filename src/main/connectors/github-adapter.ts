import { z } from 'zod'
import type { ConnectorCapabilityDefinition } from '../../shared/models'
import type { ConnectorAdapter, ConnectorExecutionContext } from './types'

const GITHUB_API_BASE = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const REQUEST_TIMEOUT_MS = 20_000

const credentialsSchema = z.object({
  token: z.string().trim().min(1).max(500),
})

const repositoryArgsSchema = z.object({
  owner: z.string().trim().min(1).max(200),
  repo: z.string().trim().min(1).max(200),
})

const searchRepositoriesArgsSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
})

const listIssuesArgsSchema = repositoryArgsSchema.extend({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.number().int().min(1).max(50).default(20),
})

const issueArgsSchema = repositoryArgsSchema.extend({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

const listPullRequestsArgsSchema = repositoryArgsSchema.extend({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.number().int().min(1).max(50).default(20),
})

const searchIssuesArgsSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
})

const createIssueArgsSchema = repositoryArgsSchema.extend({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(20_000).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
})

const commentArgsSchema = issueArgsSchema.extend({
  body: z.string().trim().min(1).max(20_000),
})

export interface GithubRequest {
  method: 'GET' | 'POST'
  path: string
  token: string
  body?: unknown
  signal?: AbortSignal
}

export interface GithubTransport {
  request<T = unknown>(input: GithubRequest): Promise<T>
}

export class GithubConnectorAdapter implements ConnectorAdapter {
  readonly kind = 'github'

  constructor(private readonly transport: GithubTransport = createGithubTransport()) {}

  async test(context: ConnectorExecutionContext): Promise<{ message: string }> {
    const token = credentialsSchema.parse(context.secrets).token
    const user = asRecord(await this.transport.request({
      method: 'GET',
      path: '/user',
      token,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }))
    const login = stringValue(user.login, 'GitHub user login')
    return { message: `Connected to GitHub as ${login}` }
  }

  async call(
    context: ConnectorExecutionContext,
    capability: ConnectorCapabilityDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const token = credentialsSchema.parse(context.secrets).token
    const request = (method: GithubRequest['method'], path: string, body?: unknown) => this.transport.request({
      method,
      path,
      token,
      ...(body === undefined ? {} : { body }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })

    switch (capability.id) {
      case 'github.searchRepositories': {
        const input = searchRepositoriesArgsSchema.parse(args)
        const result = asRecord(await request('GET', `/search/repositories?q=${encodeURIComponent(input.query)}&per_page=${input.limit}`))
        return {
          totalCount: numberValue(result.total_count, 'repository count'),
          repositories: records(result.items).map(repositorySummary),
        }
      }
      case 'github.searchIssues': {
        const input = searchIssuesArgsSchema.parse(args)
        const result = asRecord(await request('GET', `/search/issues?q=${encodeURIComponent(input.query)}&per_page=${input.limit}`))
        return {
          totalCount: numberValue(result.total_count, 'issue count'),
          items: records(result.items).map(issueSummary),
        }
      }
      case 'github.listIssues': {
        const input = listIssuesArgsSchema.parse(args)
        const result = await request('GET', `/repos/${repositoryPath(input)}/issues?state=${input.state}&per_page=${input.limit}`)
        return {
          issues: records(result)
            .filter((issue) => issue.pull_request === undefined)
            .map(issueSummary),
        }
      }
      case 'github.getIssue': {
        const input = issueArgsSchema.parse(args)
        const issue = asRecord(await request('GET', `/repos/${repositoryPath(input)}/issues/${input.number}`))
        return issueDetail(issue)
      }
      case 'github.listPullRequests': {
        const input = listPullRequestsArgsSchema.parse(args)
        const result = await request('GET', `/repos/${repositoryPath(input)}/pulls?state=${input.state}&per_page=${input.limit}`)
        return { pullRequests: records(result).map(pullRequestSummary) }
      }
      case 'github.getPullRequest': {
        const input = issueArgsSchema.parse(args)
        const pullRequest = asRecord(await request('GET', `/repos/${repositoryPath(input)}/pulls/${input.number}`))
        return pullRequestDetail(pullRequest)
      }
      case 'github.createIssue': {
        const input = createIssueArgsSchema.parse(args)
        const issue = asRecord(await request('POST', `/repos/${repositoryPath(input)}/issues`, {
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
        }))
        return issueDetail(issue)
      }
      case 'github.comment': {
        const input = commentArgsSchema.parse(args)
        const comment = asRecord(await request(
          'POST',
          `/repos/${repositoryPath(input)}/issues/${input.number}/comments`,
          { body: input.body },
        ))
        return {
          id: numberValue(comment.id, 'comment id'),
          htmlUrl: stringValue(comment.html_url, 'comment URL'),
          createdAt: stringValue(comment.created_at, 'comment creation time'),
        }
      }
      default:
        throw new Error(`Unknown GitHub capability: ${capability.id}`)
    }
  }
}

export function createGithubTransport(fetchImpl: typeof fetch = fetch): GithubTransport {
  return {
    async request<T>(input: GithubRequest): Promise<T> {
      if (!input.path.startsWith('/') || input.path.startsWith('//')) {
        throw new Error('GitHub API path must be relative to api.github.com')
      }
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const response = await fetchImpl(`${GITHUB_API_BASE}${input.path}`, {
        method: input.method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': 'barn-desktop',
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]),
      })
      const text = await response.text()
      const payload: unknown = text.length === 0 ? undefined : parseJson(text)
      if (!response.ok) throw new Error(githubErrorMessage(response, payload))
      return payload as T
    },
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('GitHub API returned an invalid JSON response')
  }
}

function githubErrorMessage(response: Response, payload: unknown): string {
  let message = ''
  if (isRecord(payload) && typeof payload.message === 'string') message = payload.message.trim()
  if (response.status === 401) return 'GitHub rejected the personal access token'
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    return 'GitHub API rate limit reached; try again later'
  }
  if (response.status === 404) return 'GitHub resource not found or the token cannot access it'
  return `GitHub API returned HTTP ${response.status}${message.length === 0 ? '' : `: ${message}`}`
}

function repositoryPath(input: { owner: string; repo: string }): string {
  return `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
}

function repositorySummary(value: Record<string, unknown>) {
  const owner = isRecord(value.owner) ? value.owner : {}
  return {
    id: numberValue(value.id, 'repository id'),
    fullName: stringValue(value.full_name, 'repository full name'),
    name: stringValue(value.name, 'repository name'),
    owner: stringValue(owner.login, 'repository owner'),
    private: value.private === true,
    description: nullableString(value.description),
    defaultBranch: stringValue(value.default_branch, 'default branch'),
    htmlUrl: stringValue(value.html_url, 'repository URL'),
    pushedAt: nullableString(value.pushed_at),
  }
}

function issueSummary(value: Record<string, unknown>) {
  return {
    id: numberValue(value.id, 'issue id'),
    number: numberValue(value.number, 'issue number'),
    title: stringValue(value.title, 'issue title'),
    state: stringValue(value.state, 'issue state'),
    isPullRequest: value.pull_request !== undefined,
    author: userLogin(value.user),
    labels: records(value.labels).flatMap((label): string[] => (
      typeof label.name === 'string' ? [label.name] : []
    )),
    comments: numberValue(value.comments, 'comment count'),
    htmlUrl: stringValue(value.html_url, 'issue URL'),
    createdAt: stringValue(value.created_at, 'creation time'),
    updatedAt: stringValue(value.updated_at, 'update time'),
  }
}

function issueDetail(value: Record<string, unknown>) {
  return {
    ...issueSummary(value),
    body: boundedText(value.body),
  }
}

function pullRequestSummary(value: Record<string, unknown>) {
  const head = isRecord(value.head) ? value.head : {}
  const base = isRecord(value.base) ? value.base : {}
  return {
    id: numberValue(value.id, 'pull request id'),
    number: numberValue(value.number, 'pull request number'),
    title: stringValue(value.title, 'pull request title'),
    state: stringValue(value.state, 'pull request state'),
    draft: value.draft === true,
    author: userLogin(value.user),
    head: stringValue(head.ref, 'pull request head branch'),
    base: stringValue(base.ref, 'pull request base branch'),
    htmlUrl: stringValue(value.html_url, 'pull request URL'),
    createdAt: stringValue(value.created_at, 'creation time'),
    updatedAt: stringValue(value.updated_at, 'update time'),
  }
}

function pullRequestDetail(value: Record<string, unknown>) {
  return {
    ...pullRequestSummary(value),
    body: boundedText(value.body),
    mergeableState: nullableString(value.mergeable_state),
    commits: optionalNumber(value.commits),
    additions: optionalNumber(value.additions),
    deletions: optionalNumber(value.deletions),
    changedFiles: optionalNumber(value.changed_files),
  }
}

function userLogin(value: unknown): string | undefined {
  return isRecord(value) && typeof value.login === 'string' ? value.login : undefined
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length <= 20_000 ? value : `${value.slice(0, 20_000)}\n…`
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`GitHub response is missing ${label}`)
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new Error(`GitHub response is missing ${label}`)
  return value
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('GitHub API returned an invalid response')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
