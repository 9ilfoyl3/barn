import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test } from '@playwright/test'

test('turns a changed GitHub event into a durable suggestion and completed task in the real SQLite store', async () => {
  test.setTimeout(90_000)
  const github = createGithubFixtureServer()
  const server = await startFixtureServer(github)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const userData = await mkdtemp(join(tmpdir(), 'barn-proactive-connector-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const launch = (): ReturnType<typeof electron.launch> => electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
      BARN_GITHUB_API_BASE_URL: baseUrl,
    },
  })

  let app = await launch()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'proactive-e2e-provider',
        name: 'Proactive E2E Provider',
        baseUrl: `${url}/v1`,
        api: 'openai-completions',
        models: [{
          id: 'proactive-e2e-model',
          name: 'Proactive E2E Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'proactive-e2e-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'proactive-e2e-provider', modelId: 'proactive-e2e-model' })
    }, baseUrl)

    await page.locator('.app-rail-button', { hasText: 'Plugins' }).click()
    const plugins = page.locator('.plugins-page')
    await expect(plugins).toBeVisible()
    await plugins.locator('[data-plugin-kind="github"]').getByRole('button', { name: 'Add GitHub' }).click()
    await plugins.getByRole('textbox', { name: 'Connection name' }).fill('GitHub work')
    await plugins.getByLabel('Personal access token').fill('github_pat_fixture')
    await plugins.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(plugins.locator('.plugin-instance-row')).toContainText('GitHub work')
    await expect.poll(async () => page.evaluate(async () => (
      await window.barn.connectors.list()
    ).map((connector) => connector.status))).toEqual(['ready'])
    await plugins.getByRole('button', { name: 'Back to plugins' }).click()

    await plugins.getByRole('tab', { name: 'Sources' }).click()
    const sourcesPage = page.locator('.automation-sources-page')
    await expect(sourcesPage).toBeVisible()
    await expect(sourcesPage.getByText('No connected app sources yet')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-automation-sources-empty.png', fullPage: true })

    await sourcesPage.getByRole('button', { name: 'Add connected source' }).click()
    const form = sourcesPage.locator('.automation-source-form')
    await form.getByLabel('Connection').selectOption({ label: 'GitHub work' })
    await form.getByLabel('Source name').fill('Payments issue watch')
    await form.getByLabel('Repository owner').fill('acme')
    await form.getByLabel('Repository name').fill('payments')
    await form.getByLabel('Check every seconds').fill('60')
    await form.getByRole('button', { name: 'Add connected source' }).click()
    await expect(sourcesPage.locator('[data-source-kind="github"]')).toContainText('Payments issue watch')
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectorSources.list()).length)).toBe(1)
    await expect(page.locator('.barn-toast')).toHaveCount(0, { timeout: 8_000 })

    await sourcesPage.getByRole('button', { name: 'Check now' }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectorSources.listEvents()).length)).toBe(1)
    await expect(page.evaluate(async () => (await window.barn.tasks.list()).length)).resolves.toBe(0)

    github.version = 2
    await sourcesPage.getByRole('button', { name: 'Check now' }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.tasks.list()).length)).toBe(1)
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectorSources.listEvents()).length)).toBe(2)
    await expect(sourcesPage.locator('.automation-event-list')).toContainText('Suggestion created')
    await page.evaluate(() => { const panel = document.querySelector('.plugins-page'); if (panel instanceof HTMLElement) panel.scrollTop = 0 })
    await page.screenshot({ path: 'test-results/barn-automation-sources.png', fullPage: true })

    const task = await page.evaluate(async () => (await window.barn.tasks.list())[0])
    if (task === undefined) throw new Error('Expected a suggested Task')
    expect(task).toMatchObject({
      title: 'Review GitHub issue #42: Payment retries fail after upgrade',
      status: 'proposed',
      origin: 'automation',
    })

    await page.locator('.task-nav-button').click()
    await expect(page.getByRole('heading', { name: 'All tasks', level: 1 })).toBeVisible()
    const taskRow = page.locator('.task-row', { hasText: 'Payment retries fail after upgrade' })
    await expect(taskRow).toContainText('Suggested')
    await expect(page.locator('.barn-toast')).toHaveCount(0, { timeout: 8_000 })
    await page.screenshot({ path: 'test-results/barn-automation-needs-you.png', fullPage: true })

    await taskRow.getByRole('button', { name: 'Run', exact: true }).click()
    await expect.poll(async () => page.evaluate(async (taskId) => (
      await window.barn.tasks.get(taskId)
    ).status, task.id), { timeout: 20_000 }).toBe('completed')
    await expect(taskRow.locator('.task-status')).toHaveText('Completed')
    await page.screenshot({ path: 'test-results/barn-automation-task-completed.png', fullPage: true })
    await taskRow.getByRole('button', { name: /View details:/ }).click()
    await expect(page.locator('.task-detail-page')).toContainText('migration path')
    await page.screenshot({ path: 'test-results/barn-automation-task-result.png', fullPage: true })
    await page.locator('.task-detail-back').click()

    await app.close()
    app = await launch()
    const reopened = await app.firstWindow()
    await reopened.waitForLoadState('domcontentloaded')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await reopened.locator('.app-rail-button', { hasText: 'Plugins' }).click()
    await reopened.locator('.plugins-page').getByRole('tab', { name: 'Sources' }).click()
    await expect(reopened.locator('.automation-sources-page')).toContainText('Payments issue watch')
    await expect(reopened.locator('.automation-event-list')).toContainText('Suggestion created')
    await reopened.evaluate(() => { const panel = document.querySelector('.plugins-page'); if (panel instanceof HTMLElement) panel.scrollTop = 0 })
    await reopened.screenshot({ path: 'test-results/barn-automation-sources-restart.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }

  const database = new DatabaseSync(join(userData, 'sessions', 'sessions.db'))
  const sources = database.prepare('SELECT COUNT(*) AS count FROM connector_sources').get() as { count: number }
  const events = database.prepare('SELECT COUNT(*) AS count FROM connector_source_events').get() as { count: number }
  const tasks = database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }
  const completed = database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'completed'").get() as { count: number }
  expect(sources.count).toBe(1)
  expect(events.count).toBe(2)
  expect(tasks.count).toBe(1)
  expect(completed.count).toBe(1)
  database.close()
})

function createGithubFixtureServer(): { version: number } {
  return { version: 1 }
}

async function startFixtureServer(github: { version: number }): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      request.resume()
      request.on('end', () => writeModelResponse(response))
      return
    }
    if (request.method === 'GET' && request.url === '/user') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ login: 'barn-bot' }))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/acme/payments/issues')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([githubIssue(github.version)]))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/repos/acme/payments/pulls')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('[]')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

function githubIssue(version: number): Record<string, unknown> {
  const updatedAt = version === 1 ? '2026-11-26T08:00:00.000Z' : '2026-11-26T09:00:00.000Z'
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
    updated_at: updatedAt,
  }
}

function writeModelResponse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-proactive-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'proactive-e2e-model',
  }
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'The issue affects payment retries after upgrade. Recommend checking the migration path and drafting a concise triage note; no external changes were made.' }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 24, total_tokens: 44 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}
