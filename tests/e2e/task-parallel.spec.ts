import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('runs independent Tasks in parallel and keeps Worker progress out of the main Thread', async () => {
  const model = await startParallelModelServer()
  const address = model.server.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-parallel-e2e-'))
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
        id: 'parallel-provider',
        name: 'Parallel Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'parallel-model',
          name: 'Parallel Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'parallel-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'parallel-provider', modelId: 'parallel-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const tasks = await page.evaluate(async () => Promise.all([
      window.barn.tasks.create({ title: 'Task A', origin: 'user', prompt: 'Complete task A.' }),
      window.barn.tasks.create({ title: 'Task B', origin: 'user', prompt: 'Complete task B.' }),
    ]))

    await expect.poll(async () => page.evaluate(async (taskIds) => Promise.all(
      taskIds.map((id) => window.barn.tasks.get(id).then((task) => task.status)),
    ), tasks.map((task) => task.id)), { timeout: 15_000 }).toEqual(['running', 'running'])
    await expect.poll(() => model.startedCount(), { timeout: 15_000 }).toBe(2)
    await expect.poll(async () => page.evaluate(async () => (await window.barn.sessions.list()).length), { timeout: 15_000 }).toBe(2)
    expect(await page.evaluate(async () => (await window.barn.threads.getSnapshot()).messages)).toEqual([])

    model.release()
    await expect.poll(async () => page.evaluate(async (taskIds) => Promise.all(
      taskIds.map((id) => window.barn.tasks.get(id).then((task) => task.status)),
    ), tasks.map((task) => task.id)), { timeout: 15_000 }).toEqual(['completed', 'completed'])
    expect(await page.evaluate(async () => (await window.barn.threads.getSnapshot()).messages)).toEqual([])
    await page.screenshot({ path: 'test-results/barn-task-parallel.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => model.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startParallelModelServer(): Promise<{
  server: Server
  startedCount: () => number
  release: () => void
}> {
  let started = 0
  let releaseRequests: (() => void) | undefined
  const released = new Promise<void>((resolve) => { releaseRequests = resolve })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', async () => {
      started++
      await released
      const text = body.includes('Complete task A') ? 'Task A completed.' : 'Task B completed.'
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-parallel-${started}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'parallel-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, startedCount: () => started, release: () => releaseRequests?.() }
}
