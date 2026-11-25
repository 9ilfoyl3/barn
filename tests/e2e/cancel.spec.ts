import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('cancels an in-progress Router request', async () => {
  const intervals = new Set<NodeJS.Timeout>()
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
        id: 'chatcmpl-cancel',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Starting a long response. ' }, finish_reason: null }],
      })}\n\n`)
      const interval = setInterval(() => {
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { content: 'Still running. ' }, finish_reason: null }],
        })}\n\n`)
      }, 100)
      intervals.add(interval)
      response.on('close', () => {
        clearInterval(interval)
        intervals.delete(interval)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-cancel-e2e-'))
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
        id: 'cancel-provider',
        name: 'Cancel Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'mock-model',
          name: 'Mock Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'cancel-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'cancel-provider', modelId: 'mock-model' })
    }, baseUrl)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Explain this in a long response')
    await composer.press('Enter')

    await expect.poll(async () => page.evaluate(async () => (
      await window.barn.router.getSnapshot()
    ).requests[0]?.status), { timeout: 10_000 }).toBe('routing')
    const requestId = await page.evaluate(async () => (
      await window.barn.router.getSnapshot()
    ).requests[0]?.id)
    expect(requestId).toBeDefined()
    await page.evaluate((id) => window.barn.router.cancel(id), requestId!)
    await expect.poll(async () => page.evaluate(async () => (
      await window.barn.router.getSnapshot()
    ).requests[0]?.status), { timeout: 5_000 }).toBe('cancelled')
    await expect(page.getByText('Request aborted')).toHaveCount(0)
  } finally {
    for (const interval of intervals) clearInterval(interval)
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})
