import { describe, expect, it, vi } from 'vitest'
import { GITHUB_CONNECTOR } from '../../src/main/connectors/catalog'
import {
  GithubConnectorAdapter,
  createGithubTransport,
  type GithubRequest,
  type GithubTransport,
} from '../../src/main/connectors/github-adapter'
import type { ConnectorRecord } from '../../src/main/connectors/types'

const connector: ConnectorRecord = {
  id: 'github-1',
  kind: 'github',
  name: 'GitHub',
  enabled: true,
  config: {},
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
}

const secrets = { token: 'github_pat_test' }

function repositoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    full_name: 'acme/widgets',
    name: 'widgets',
    owner: { login: 'acme' },
    private: true,
    visibility: 'private',
    fork: false,
    archived: false,
    description: 'Internal widgets',
    default_branch: 'main',
    language: 'TypeScript',
    stargazers_count: 12,
    watchers_count: 12,
    forks_count: 3,
    open_issues_count: 4,
    topics: ['internal', 'widgets'],
    license: { spdx_id: 'MIT', name: 'MIT License' },
    html_url: 'https://github.com/acme/widgets',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-11-22T11:00:00Z',
    pushed_at: '2026-11-22T10:00:00Z',
    ...overrides,
  }
}

function capability(id: string) {
  const match = GITHUB_CONNECTOR.capabilities.find((entry) => entry.id === id)
  if (match === undefined) throw new Error(`Missing GitHub capability: ${id}`)
  return match
}

function requestedTransport(handler: (request: GithubRequest) => unknown): {
  requests: GithubRequest[]
  transport: GithubTransport
} {
  const requests: GithubRequest[] = []
  return {
    requests,
    transport: {
      async request<T>(request: GithubRequest): Promise<T> {
        requests.push(request)
        return handler(request) as T
      },
    },
  }
}

describe('GitHub connector', () => {
  it('authenticates the token and reports the connected account', async () => {
    const { requests, transport } = requestedTransport(() => ({ login: 'octocat' }))
    const adapter = new GithubConnectorAdapter(transport)

    await expect(adapter.test({ connector, secrets })).resolves.toEqual({
      message: 'Connected to GitHub as octocat',
    })
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/user',
      token: 'github_pat_test',
    }))
  })

  it('searches repositories and returns bounded summaries', async () => {
    const { requests, transport } = requestedTransport(() => ({
      total_count: 11,
      items: [repositoryFixture()],
    }))
    const adapter = new GithubConnectorAdapter(transport)

    await expect(adapter.call({ connector, secrets }, capability('github.searchRepositories'), {
      query: 'widgets org:acme',
      page: 2,
      perPage: 10,
    })).resolves.toEqual({
      totalCount: 11,
      page: 2,
      perPage: 10,
      hasNextPage: false,
      repositories: [{
        id: 42,
        fullName: 'acme/widgets',
        name: 'widgets',
        owner: 'acme',
        private: true,
        visibility: 'private',
        fork: false,
        archived: false,
        description: 'Internal widgets',
        defaultBranch: 'main',
        language: 'TypeScript',
        stars: 12,
        watchers: 12,
        forks: 3,
        openIssues: 4,
        topics: ['internal', 'widgets'],
        license: 'MIT',
        htmlUrl: 'https://github.com/acme/widgets',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2026-11-22T11:00:00Z',
        pushedAt: '2026-11-22T10:00:00Z',
      }],
    })
    expect(requests).toContainEqual(expect.objectContaining({
      path: '/search/repositories?q=widgets%20org%3Aacme&per_page=10&page=2',
    }))
  })

  it('lists owned repositories with pagination and complete metadata', async () => {
    const { requests, transport } = requestedTransport(() => [repositoryFixture()])
    const adapter = new GithubConnectorAdapter(transport)

    await expect(adapter.call({ connector, secrets }, capability('github.listRepositories'), {
      page: 2,
      perPage: 1,
    })).resolves.toEqual(expect.objectContaining({
      page: 2,
      perPage: 1,
      hasNextPage: true,
      repositories: [expect.objectContaining({
        fullName: 'acme/widgets',
        private: true,
        language: 'TypeScript',
        stars: 12,
        forks: 3,
        archived: false,
      })],
    }))
    expect(requests).toContainEqual(expect.objectContaining({
      path: '/user/repos?affiliation=owner&per_page=1&page=2&sort=pushed&direction=desc&visibility=all',
    }))
  })

  it('reads a repository with an exact language breakdown', async () => {
    const { transport } = requestedTransport((request) => {
      if (request.path.endsWith('/languages')) {
        return { Vue: 70, TypeScript: 20, CSS: 10 }
      }
      return repositoryFixture({ full_name: 'acme/vue-widgets', name: 'vue-widgets', language: null })
    })
    const adapter = new GithubConnectorAdapter(transport)

    await expect(adapter.call({ connector, secrets }, capability('github.getRepository'), {
      owner: 'acme',
      repo: 'vue-widgets',
    })).resolves.toEqual(expect.objectContaining({
      fullName: 'acme/vue-widgets',
      language: 'Vue',
      languages: [
        { name: 'Vue', bytes: 70, percent: 70 },
        { name: 'TypeScript', bytes: 20, percent: 20 },
        { name: 'CSS', bytes: 10, percent: 10 },
      ],
    }))
  })

  it('lists issues without mixing in pull requests', async () => {
    const { transport } = requestedTransport(() => [
      {
        id: 1,
        number: 7,
        title: 'Crash on export',
        state: 'open',
        user: { login: 'maya' },
        labels: [{ name: 'bug' }],
        comments: 2,
        html_url: 'https://github.com/acme/widgets/issues/7',
        created_at: '2026-11-20T00:00:00Z',
        updated_at: '2026-11-21T00:00:00Z',
        body: 'Export crashes',
      },
      {
        id: 2,
        number: 8,
        title: 'Improve export',
        state: 'open',
        pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/8' },
      },
    ])
    const adapter = new GithubConnectorAdapter(transport)

    const result = await adapter.call({ connector, secrets }, capability('github.listIssues'), {
      owner: 'acme',
      repo: 'widgets',
      state: 'open',
      limit: 20,
    })

    expect(result).toEqual({
      page: 1,
      perPage: 20,
      hasNextPage: false,
      issues: [expect.objectContaining({
        number: 7,
        title: 'Crash on export',
        author: 'maya',
        labels: ['bug'],
        isPullRequest: false,
      })],
    })
  })

  it('creates an issue through a POST request', async () => {
    const { requests, transport } = requestedTransport(() => ({
      id: 90,
      number: 12,
      title: 'Document export limits',
      state: 'open',
      user: { login: 'octocat' },
      labels: [],
      comments: 0,
      html_url: 'https://github.com/acme/widgets/issues/12',
      created_at: '2026-11-23T00:00:00Z',
      updated_at: '2026-11-23T00:00:00Z',
      body: 'Add the limits.',
    }))
    const adapter = new GithubConnectorAdapter(transport)

    await adapter.call({ connector, secrets }, capability('github.createIssue'), {
      owner: 'acme',
      repo: 'widgets',
      title: 'Document export limits',
      body: 'Add the limits.',
      labels: ['docs'],
    })

    expect(requests).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/repos/acme/widgets/issues',
      body: { title: 'Document export limits', body: 'Add the limits.', labels: ['docs'] },
    }))
  })

  it('comments on an issue or pull request', async () => {
    const { requests, transport } = requestedTransport(() => ({
      id: 501,
      html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-501',
      created_at: '2026-11-23T01:00:00Z',
    }))
    const adapter = new GithubConnectorAdapter(transport)

    await expect(adapter.call({ connector, secrets }, capability('github.comment'), {
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      body: 'Confirmed on the latest build.',
    })).resolves.toEqual({
      id: 501,
      htmlUrl: 'https://github.com/acme/widgets/issues/7#issuecomment-501',
      createdAt: '2026-11-23T01:00:00Z',
    })
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/repos/acme/widgets/issues/7/comments',
      body: { body: 'Confirmed on the latest build.' },
    }))
  })

  it('turns authentication failures into a safe error', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    const transport = createGithubTransport(fakeFetch)

    await expect(transport.request({
      method: 'GET',
      path: '/user',
      token: 'github_pat_secret',
    })).rejects.toThrow('GitHub rejected the personal access token')
  })

  it('sends the token only in the authorization header', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ login: 'octocat' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    const transport = createGithubTransport(fakeFetch)

    await transport.request({ method: 'GET', path: '/user', token: 'github_pat_secret' })

    expect(fakeFetch).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer github_pat_secret',
        'X-GitHub-Api-Version': '2022-11-28',
      }),
    }))
    expect(String(vi.mocked(fakeFetch).mock.calls[0]?.[0])).not.toContain('github_pat_secret')
  })
})
