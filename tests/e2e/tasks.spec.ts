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
