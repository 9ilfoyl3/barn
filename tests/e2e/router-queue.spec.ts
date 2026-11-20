import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('accepts new messages while the serial Router is still responding', async () => {
  const model = await startDelayedModelServer()
  const address = model.server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-router-queue-e2e-'))
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
        id: 'router-queue-provider',
        name: 'Router Queue Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'router-queue-model',
          name: 'Router Queue Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'router-queue-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'router-queue-provider', modelId: 'router-queue-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('What is the first answer?')
    await composer.press('Enter')
    await model.firstRequestStarted

    await expect(composer).toBeEnabled()
    await composer.fill('What is the second answer?')
    await composer.press('Enter')

    await expect(page.getByLabel('User message').getByText('What is the second answer?', { exact: true })).toBeVisible()
    await expect(page.locator('.barn-thinking-indicator')).toContainText('Thinking')
    await expect(page.locator('.assistant-reply-run')).toHaveCount(0)

    const queuedSnapshot = await page.evaluate(async () => window.barn.router.getSnapshot())
    expect(queuedSnapshot.requests).toHaveLength(2)
    expect(queuedSnapshot.requests.map((request) => request.sequence)).toEqual([1, 2])
    expect(queuedSnapshot.requests[0]).toMatchObject({ status: 'routing' })
    expect(queuedSnapshot.requests[1]).toMatchObject({ status: 'queued' })
    await expect(page.locator('.barn-thinking-indicator')).toBeVisible()

    await page.waitForTimeout(260)
    await page.screenshot({ path: 'test-results/barn-router-queue-waiting.png', fullPage: true })
    model.releaseFirst()
    await expect(page.getByText('First response').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Second response').last()).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => page.evaluate(async () => (await window.barn.router.getSnapshot()).requests.every((request) => request.status === 'completed')))
      .toBe(true)
    expect(model.requestCount()).toBe(2)
    await expect(page.locator('.barn-thinking-indicator')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/barn-router-queue.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => model.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startDelayedModelServer(): Promise<{
  server: Server
  firstRequestStarted: Promise<void>
  releaseFirst: () => void
  requestCount: () => number
}> {
  let count = 0
  let notifyFirst: (() => void) | undefined
  let release: (() => void) | undefined
  const firstRequestStarted = new Promise<void>((resolve) => { notifyFirst = resolve })
  const firstGate = new Promise<void>((resolve) => { release = resolve })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', async () => {
      count++
      const index = count
      if (index === 1) {
        notifyFirst?.()
        await firstGate
      }
      const text = JSON.stringify({
        tool: 'reply',
        arguments: { text: index === 1 ? 'First response' : 'Second response' },
        confidence: 0.98,
        rationaleCodes: ['e2e_direct_reply'],
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-router-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'router-queue-model',
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
  return {
    server,
    firstRequestStarted,
    releaseFirst: () => release?.(),
    requestCount: () => count,
  }
}
