import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('runs queued tasks in the background and preserves their Session transcript', async () => {
  const server = await startMockModelServer('Background task completed.')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-task-e2e-'))
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
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'task-provider',
        name: 'Task Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'task-model',
          name: 'Task Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'task-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'task-provider', modelId: 'task-model' })
    }, baseUrl)

    const task = await page.evaluate(() => window.barn.tasks.create({
      title: 'Prepare a background summary',
      origin: 'user',
      prompt: 'Summarize the latest project notes in one paragraph.',
    }))
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((current) => current.status),
      task.id,
    ), { timeout: 15_000 }).toBe('completed')

    const stored = await page.evaluate((taskId) => window.barn.tasks.get(taskId), task.id)
    expect(stored.sessionId).toBeDefined()
    const sessions = await page.evaluate(() => window.barn.sessions.list())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: stored.sessionId, title: 'Prepare a background summary' })
    const events = await page.evaluate((sessionId) => window.barn.sessions.getEvents(sessionId), stored.sessionId!)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'agent' }),
        data: expect.objectContaining({
          message: expect.objectContaining({
            content: [expect.objectContaining({ type: 'text', text: 'Background task completed.' })],
          }),
        }),
      }),
    ]))

    const waiting = await page.evaluate(() => window.barn.tasks.create({
      title: 'Needs instructions',
      origin: 'user',
    }))
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((current) => current.status),
      waiting.id,
    )).toBe('waiting')
    const waitingTask = await page.evaluate((taskId) => window.barn.tasks.get(taskId), waiting.id)
    expect(waitingTask).toMatchObject({
      waitingReason: 'input',
      detail: 'Add instructions before this task can run.',
    })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

test('shows needs-you, in-progress, and recent tasks with usable actions', async () => {
  const server = await startMockModelServer('Task finished from the inbox.')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-task-center-e2e-'))
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
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'task-center-provider',
        name: 'Task Center Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'task-center-model',
          name: 'Task Center Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'task-center-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'task-center-provider', modelId: 'task-center-model' })
    }, baseUrl)

    const proposed = await page.evaluate(() => window.barn.tasks.create({
      title: 'Review a suggested cleanup',
      origin: 'automation',
      status: 'proposed',
    }))
    const waiting = await page.evaluate(() => window.barn.tasks.create({
      title: 'Needs instructions',
      origin: 'user',
    }))
    const completed = await page.evaluate(() => window.barn.tasks.create({
      title: 'Finished background report',
      origin: 'user',
      prompt: 'Prepare the report.',
    }))
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((task) => task.status),
      waiting.id,
    )).toBe('waiting')
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((task) => task.status),
      completed.id,
    ), { timeout: 15_000 }).toBe('completed')
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((task) => task.status),
      proposed.id,
    )).toBe('proposed')

    await page.locator('.task-nav-button').click()
    await expect(page.getByRole('heading', { name: 'Needs you', level: 1 })).toBeVisible()
    await expect(page.locator('.task-nav-count')).toHaveText('2')
    await expect(page.getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible()
    await expect(page.getByText('2 tasks need you.')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-task-center.png', fullPage: true })

    const proposedRow = page.locator('.task-row', { hasText: 'Review a suggested cleanup' })
    await proposedRow.getByRole('button', { name: 'Add instructions' }).click()
    const editor = proposedRow.getByRole('textbox', { name: 'Task instructions' })
    await expect(editor).toBeFocused()
    await editor.fill('Review the files and remove only exact duplicates.')
    await proposedRow.getByRole('button', { name: 'Save and run' }).click()
    await expect(proposedRow.locator('.task-status')).toHaveText('Completed', { timeout: 15_000 })

    const completedRow = page.locator('.task-row', { hasText: 'Finished background report' })
    await completedRow.getByRole('button', { name: 'Open' }).click()
    await expect(page.locator('.conversation-surface')).toContainText('Task finished from the inbox.')
    await expect(page.getByRole('button', { name: /New session/i })).toHaveCount(0)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})


test('requires durable approval before a task can resume', async () => {
  const server = await startMockModelServer('Approved task completed.')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-approval-e2e-'))
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
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'approval-provider',
        name: 'Approval Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'approval-model',
          name: 'Approval Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'approval-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'approval-provider', modelId: 'approval-model' })
    }, baseUrl)

    const task = await page.evaluate(() => window.barn.tasks.create({
      title: 'Send the approved draft',
      origin: 'user',
      status: 'proposed',
      prompt: 'Send the prepared draft.',
    }))
    const outcome = await page.evaluate((taskId) => window.barn.permissions.request({
      kind: 'external-write',
      title: 'Send draft',
      summary: 'Send the prepared draft externally.',
      taskId,
    }), task.id)
    expect(outcome.decision).toBe('approval_required')
    if (outcome.decision !== 'approval_required') throw new Error('approval expected')
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((current) => current.status),
      task.id,
    )).toBe('waiting')

    await page.locator('.task-nav-button').click()
    const row = page.locator('.task-row', { hasText: 'Send the approved draft' })
    await expect(row).toContainText('Waiting')
    await expect(row).toContainText('Send the prepared draft externally.')
    await row.getByRole('button', { name: 'Approve' }).click()
    await expect(row.locator('.task-status')).toHaveText('Completed', { timeout: 15_000 })
    const approval = await page.evaluate(
      (approvalId) => window.barn.approvals.get(approvalId),
      outcome.approval.id,
    )
    expect(approval.status).toBe('approved')
    expect(approval.resolvedAt).toBeDefined()
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startMockModelServer(text: string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: 'chatcmpl-task',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'task-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}
