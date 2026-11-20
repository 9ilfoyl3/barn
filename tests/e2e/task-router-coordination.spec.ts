import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('lets exactly one Task authority answer a Task-detail message', async () => {
  const model = await startTaskRouterModelServer()
  const address = model.server.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-router-e2e-'))
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'task-router-provider',
        name: 'Task Router Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'task-router-model',
          name: 'Task Router Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'task-router-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'task-router-provider', modelId: 'task-router-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const task = await page.evaluate(() => window.barn.tasks.create({
      title: 'Check the project status',
      origin: 'user',
      prompt: 'Prepare the initial status result.',
    }))
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((current) => current.status),
      task.id,
    ), { timeout: 15_000 }).toBe('completed')
    expect(model.workerStarted()).toBe(1)

    await page.locator('.task-nav-button').click()
    await page.locator('.task-row', { hasText: 'Check the project status' })
      .getByRole('button', { name: 'View details', exact: true })
      .click()
    const detail = page.locator('.task-detail-page')
    const composer = detail.getByRole('textbox', { name: 'Message task agent' })
    const initialWorkerCount = model.workerStarted()

    await composer.fill('What is the status?')
    await composer.press('Enter')
    await expect(detail).toContainText('The task is complete and the Worker result is available.')
    await expect(detail.locator('[data-actor-role="router"]').filter({ hasText: 'The task is complete and the Worker result is available.' })).toBeVisible()
    expect(model.workerStarted()).toBe(initialWorkerCount)
    expect(model.workerPrompts()).toHaveLength(initialWorkerCount)

    await composer.fill('Check again with a fresh result.')
    await composer.press('Enter')
    await expect.poll(() => model.workerStarted(), { timeout: 15_000 }).toBe(initialWorkerCount + 1)
    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((current) => current.status),
      task.id,
    ), { timeout: 15_000 }).toBe('completed')
    await expect(detail).toContainText('Updated worker result.')
    await expect(detail.locator('[data-actor-role="worker"]').filter({ hasText: 'Updated worker result.' })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-task-router-coordination.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => model.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startTaskRouterModelServer(): Promise<{
  server: Server
  workerStarted: () => number
  workerPrompts: () => string[]
}> {
  let workerStarted = 0
  const workerPrompts: string[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (body.includes("You are Barn's Task Router")) {
        if (extractUserMessage(body) === 'What is the status?') {
          sendText(response, JSON.stringify({
            tool: 'router.reply',
            arguments: { text: 'The task is complete and the Worker result is available.' },
            confidence: 0.99,
            rationaleCodes: ['e2e_status_reply'],
          }))
          return
        }
        sendText(response, JSON.stringify({
          tool: 'worker.dispatch',
          arguments: {},
          confidence: 0.98,
          rationaleCodes: ['e2e_worker_dispatch'],
        }))
        return
      }

      workerStarted += 1
      workerPrompts.push(body)
      sendText(response, body.includes('Check again with a fresh result.')
        ? 'Updated worker result.'
        : 'Initial task result.')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    server,
    workerStarted: () => workerStarted,
    workerPrompts: () => workerPrompts,
  }
}

function extractUserMessage(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
    for (const message of payload.messages?.toReversed() ?? []) {
      if (message.role !== 'user' || typeof message.content !== 'string') continue
      try {
        const context = JSON.parse(message.content) as { userMessage?: unknown }
        if (typeof context.userMessage === 'string') return context.userMessage
      } catch {
        return message.content
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function sendText(response: ServerResponse, text: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-task-router',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'task-router-model',
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
}
