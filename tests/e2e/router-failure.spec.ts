import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('shows a durable error when the Router returns an invalid decision', async () => {
  const model = await startInvalidRouterServer()
  const address = model.address()
  if (address === null || typeof address === 'string') throw new Error('Mock model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-router-failure-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'zh-CN',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'invalid-router-provider',
        name: 'Invalid Router Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'invalid-router-model',
          name: 'Invalid Router Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'invalid-router-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'invalid-router-provider', modelId: 'invalid-router-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('给 Barn 发消息')
    await composer.fill('我明天能穿什么衣服出门？')
    await composer.press('Enter')

    const errorMessage = page.locator('.chat-message.assistant.error')
    await expect(errorMessage).toContainText('Router 返回了无法识别的结果', { timeout: 15_000 })
    await expect.poll(async () => page.evaluate(async () => {
      const snapshot = await window.barn.router.getSnapshot()
      return {
        status: snapshot.requests[0]?.status,
        hasReplyMessage: snapshot.requests[0]?.replyMessageId !== undefined,
        orbs: document.querySelectorAll('.assistant-live-activity').length,
      }
    })).toEqual({ status: 'failed', hasReplyMessage: true, orbs: 0 })
    await page.screenshot({ path: 'test-results/barn-router-failure.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => model.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startInvalidRouterServer(): Promise<Server> {
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
        id: 'chatcmpl-invalid-router',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'invalid-router-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '建议穿一件外套。' },
          finish_reason: null,
        }],
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
  return server
}
