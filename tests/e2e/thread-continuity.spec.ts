import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('restores one continuous Assistant Thread across app restarts', async () => {
  const server = await startModelServer('Stored. The launch code is 4721.')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-thread-continuity-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const launch = () => electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
    },
  })

  const first = await launch()
  try {
    const page = await first.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'thread-provider',
        name: 'Thread Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'thread-model',
          name: 'Thread Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'thread-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'thread-provider', modelId: 'thread-model' })
    }, baseUrl)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Remember that the launch code is 4721.')
    await composer.press('Enter')
    await expect(page.getByText('Stored. The launch code is 4721.').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.thread-message')).toHaveCount(2)
    await expect(page.locator('.session-row')).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.barn.threads.getSnapshot()).messages.length)).toBe(2)
  } finally {
    await first.close()
  }

  const second = await launch()
  try {
    const page = await second.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByText('Remember that the launch code is 4721.')).toBeVisible()
    await expect(page.getByText('Stored. The launch code is 4721.')).toBeVisible()
    await expect(page.locator('.session-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /New session/i })).toHaveCount(0)
  } finally {
    await second.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startModelServer(text: string): Promise<Server> {
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
        id: 'chatcmpl-thread',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'thread-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}
