import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test } from '@playwright/test'

test('guard nudges a silent worker once, pauses the task, and persists both run attempts', async () => {
  test.setTimeout(60_000)
  const holding = await startHoldingModelServer()
  const address = holding.server.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-guard-e2e-'))
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
      BARN_TASK_GUARD_INTERVAL_MS: '250',
      BARN_TASK_GUARD_SILENT_MS: '1200',
      BARN_TASK_GUARD_GRACE_MS: '1000',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'guard-e2e-provider',
        name: 'Guard E2E Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'guard-e2e-model',
          name: 'Guard E2E Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'guard-e2e-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'guard-e2e-provider', modelId: 'guard-e2e-model' })
    }, baseUrl)

    const task = await page.evaluate(() => window.barn.tasks.create({
      title: 'Investigate a stuck background report',
      origin: 'user',
      prompt: 'Investigate the report and publish one final result.',
    }))

    await expect.poll(() => holding.requests(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(async () => page.evaluate(async (taskId) => {
      const current = await window.barn.tasks.get(taskId)
      return { status: current.status, waitingReason: current.waitingReason, detail: current.detail }
    }, task.id), { timeout: 15_000 }).toMatchObject({
      status: 'waiting',
      waitingReason: 'input',
      detail: expect.stringContaining('Guard paused'),
    })

    const events = await page.evaluate(async () => {
      const current = (await window.barn.tasks.list()).find((candidate) => candidate.title === 'Investigate a stuck background report')
      return current?.sessionId === undefined ? [] : window.barn.sessions.getEvents(current.sessionId)
    })
    expect(events.some((event) => JSON.stringify(event).includes('Guard check'))).toBe(true)

    await page.locator('.task-nav-button').click()
    await expect(page.getByRole('heading', { name: 'All tasks', level: 1 })).toBeVisible()
    const row = page.locator('.task-row', { hasText: 'Investigate a stuck background report' })
    await expect(row).toContainText('Waiting')
    await expect(row).toContainText('Guard paused')
    await page.screenshot({ path: 'test-results/barn-task-guard-needs-you.png', fullPage: true })
    await row.getByRole('button', { name: /View details:/ }).click()
    await expect(page.locator('.task-detail-page')).toContainText('Waiting')
    await expect(page.locator('.task-detail-page')).toContainText('Guard check')
    await page.screenshot({ path: 'test-results/barn-task-guard-detail.png', fullPage: true })
  } finally {
    await app.close()
    holding.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => holding.server.close((error) => error === undefined ? resolve() : reject(error)))
  }

  const database = new DatabaseSync(join(userData, 'sessions', 'sessions.db'))
  const runs = database.prepare('SELECT status, guard_state FROM task_runs ORDER BY attempt ASC').all() as Array<{ status: string; guard_state: string }>
  const task = database.prepare("SELECT status, waiting_reason FROM tasks WHERE title = 'Investigate a stuck background report'").get() as { status: string; waiting_reason: string }
  expect(task).toEqual({ status: 'waiting', waiting_reason: 'input' })
  expect(runs).toEqual([
    { status: 'cancelled', guard_state: 'watching' },
    { status: 'waiting', guard_state: 'escalated' },
  ])
  database.close()
})

async function startHoldingModelServer(): Promise<{ server: Server; requests: () => number }> {
  let requests = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    requests++
    request.resume()
    request.on('end', () => hold(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests: () => requests }
}

function hold(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.write(': waiting\n\n')
}
