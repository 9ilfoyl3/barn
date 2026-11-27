import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('auto-watches GitHub and creates a natural-language watch through the Router', async () => {
  test.setTimeout(90_000)
  const fixture = await startFixtureServer()
  const address = fixture.server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const userData = await mkdtemp(join(tmpdir(), 'barn-router-watch-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
      BARN_GITHUB_API_BASE_URL: baseUrl,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'watch-router-provider',
        name: 'Watch Router Provider',
        baseUrl: `${url}/v1`,
        api: 'openai-completions',
        models: [{
          id: 'watch-router-model',
          name: 'Watch Router Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'watch-router-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'watch-router-provider', modelId: 'watch-router-model' })
    }, baseUrl)

    await page.locator('.app-rail-button', { hasText: 'Plugins' }).click()
    const plugins = page.locator('.plugins-page')
    await expect(plugins).toBeVisible()
    await expect(plugins.getByRole('tab', { name: 'Sources' })).toHaveCount(0)
    await plugins.locator('[data-plugin-kind="github"]').getByRole('button', { name: 'Add GitHub' }).click()
    await plugins.getByRole('textbox', { name: 'Connection name' }).fill('GitHub work')
    await plugins.getByLabel('Personal access token').fill('github_pat_fixture')
    await plugins.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(plugins.locator('.plugin-instance-row')).toContainText('GitHub work')
    await expect.poll(async () => page.evaluate(async () => (
      await window.barn.connectors.list()
    ).map((connector) => connector.status))).toEqual(['ready'])
    await plugins.getByRole('button', { name: 'Back to plugins' }).click()
    await expect(page.locator('.barn-toast')).toHaveCount(0, { timeout: 8_000 })
    await expect(plugins.getByRole('tab', { name: 'Plugins' })).toBeVisible()
    await expect(plugins.getByRole('tab', { name: 'Skills' })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-plugins-no-sources.png', fullPage: true })

    await expect.poll(async () => page.evaluate(async () => {
      const sources = await window.barn.connectorSources.list()
      return sources.map((source) => ({
        provider: source.config.kind,
        scope: source.config.kind === 'github' ? source.config.scope : undefined,
        origin: source.config.kind === 'github' ? source.config.origin : undefined,
      }))
    })).toContainEqual({ provider: 'github', scope: 'bound-user', origin: 'github-default' })
    await expect.poll(async () => page.evaluate(async () => {
      const source = (await window.barn.connectorSources.list()).find((candidate) => candidate.config.kind === 'github' && candidate.config.origin === 'github-default')
      return source === undefined ? 0 : (await window.barn.connectorSources.listEvents(source.id)).length
    })).toBe(1)
    expect(await page.evaluate(async () => (await window.barn.tasks.list()).length)).toBe(0)

    fixture.version = 2
    await page.evaluate(() => window.barn.connectorSources.pollNow())
    await expect.poll(async () => page.evaluate(async () => (await window.barn.tasks.list()).length)).toBe(1)
    const task = await page.evaluate(async () => (await window.barn.tasks.list())[0])
    expect(task).toMatchObject({
      status: 'proposed',
      title: 'Review GitHub acme/payments issue #42: Payment retries fail after upgrade',
    })

    await page.locator('.app-rail-button', { hasText: 'Home' }).click()
    const composer = page.getByLabel('Message Barn')
    await composer.fill('Watch acme/payments and only issues from octocat. Analyze anything that needs my attention.')
    await composer.press('Enter')
    await expect(page.getByText('I’ll watch acme/payments for octocat issues and analyze what needs attention.', { exact: true }))
      .toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectorSources.list()).map((source) => ({
      scope: source.config.kind === 'github' ? source.config.scope : undefined,
      origin: source.config.kind === 'github' ? source.config.origin : undefined,
      actors: source.config.kind === 'github' ? source.config.actors : undefined,
      instruction: source.config.instruction,
    })))).toContainEqual({
      scope: 'repository',
      origin: 'router',
      actors: ['octocat'],
      instruction: 'Watch issues from octocat in acme/payments and analyze what needs attention.',
    })
    await expect(page.locator('.barn-toast')).toHaveCount(0, { timeout: 8_000 })
    await page.screenshot({ path: 'test-results/barn-router-managed-watch.png', fullPage: true })

    await page.locator('.task-nav-button').click()
    await expect(page.locator('.task-row', { hasText: 'Payment retries fail after upgrade' })).toBeVisible()
    await expect(page.locator('.barn-toast')).toHaveCount(0, { timeout: 8_000 })
    await page.screenshot({ path: 'test-results/barn-default-github-watch-task.png', fullPage: true })
  } finally {
    await app.close()
    fixture.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startFixtureServer(): Promise<{ server: Server; version: number }> {
  const state = { version: 1, modelRequests: 0 }
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      request.resume()
      request.on('end', () => writeRouterResponse(response, ++state.modelRequests))
      return
    }
    if (request.method === 'GET' && request.url === '/user') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ login: 'barn-bot' }))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/user/repos')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
        id: 1001,
        full_name: 'acme/payments',
        name: 'payments',
        owner: { login: 'acme' },
        private: true,
        visibility: 'private',
        fork: false,
        archived: false,
        default_branch: 'main',
        stargazers_count: 1,
        watchers_count: 1,
        forks_count: 0,
        open_issues_count: 1,
        topics: [],
        html_url: 'https://github.com/acme/payments',
        created_at: '2026-11-20T00:00:00.000Z',
        updated_at: '2026-11-26T00:00:00.000Z',
        pushed_at: '2026-11-26T00:00:00.000Z',
      }]))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/acme/payments/issues')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([githubIssue(state.version)]))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/acme/payments/pulls')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('[]')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    get version() { return state.version },
    set version(value: number) { state.version = value },
    server,
  }
}

function githubIssue(version: number): Record<string, unknown> {
  return {
    id: 10042,
    number: 42,
    title: version === 1 ? 'Payment retries fail' : 'Payment retries fail after upgrade',
    state: 'open',
    user: { login: 'octocat' },
    labels: [{ name: 'bug' }, { name: 'payments' }],
    comments: version,
    html_url: 'https://github.com/acme/payments/issues/42',
    created_at: '2026-11-26T07:00:00.000Z',
    updated_at: version === 1 ? '2026-11-26T08:00:00.000Z' : '2026-11-26T09:00:00.000Z',
  }
}

function writeRouterResponse(response: ServerResponse, requestNumber: number): void {
  if (requestNumber === 1) {
    sendToolCall(response, 'call', {
      tool: 'watch_create',
      params: {
        provider: 'github',
        target: 'acme/payments',
        actors: ['octocat'],
        keywords: [],
        purpose: 'analysis',
        instruction: 'Watch issues from octocat in acme/payments and analyze what needs attention.',
      },
    })
    return
  }
  sendToolCall(response, 'route_decision', {
    tool: 'reply',
    arguments: { text: 'I’ll watch acme/payments for octocat issues and analyze what needs attention.' },
    confidence: 0.99,
    rationaleCodes: ['create_connector_watch'],
  })
}

function sendToolCall(response: ServerResponse, name: string, args: Record<string, unknown>): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-watch-router',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'watch-router-model',
  }
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}
