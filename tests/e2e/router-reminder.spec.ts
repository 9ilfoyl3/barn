import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('turns a reminder into a scheduled task without entering a tool Session', async () => {
  const modelServer = await startReminderRouterServer()
  const address = modelServer.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-router-reminder-e2e-'))
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
        id: 'reminder-router-provider',
        name: 'Reminder Router Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'reminder-router-model',
          name: 'Reminder Router Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'reminder-router-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'reminder-router-provider', modelId: 'reminder-router-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('给 Barn 发消息')
    await composer.fill('提醒我明天要带退货的衣服')
    await composer.press('Enter')

    await expect(page.locator('.assistant-result')).toContainText('带退货的衣服')
    await expect(page.locator('.router-message-state')).toContainText('任务已创建')
    await expect(page.locator('.task-rail-card')).toContainText('已排期')
    await expect(page.locator('.agent-thinking-state')).toHaveCount(0)
    await expect(page.locator('.tool-group')).toHaveCount(0)
    await expect(page.locator('.live-turn')).toHaveCount(0)

    const tasks = await page.evaluate(async () => window.barn.tasks.list())
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      kind: 'reminder',
      scheduledFor: '2026-11-19T01:00:00.000Z',
      visiblePrompt: '提醒我带退货的衣服。',
      status: 'queued',
    })
    expect(await page.evaluate(async () => window.barn.sessions.list())).toEqual([])
    await page.screenshot({ path: 'test-results/barn-router-reminder.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startReminderRouterServer(): Promise<Server> {
  const decision = JSON.stringify({
    tool: 'schedule.create',
    arguments: {
      title: '带退货的衣服',
      text: '提醒我带退货的衣服。',
      scheduledFor: '2026-11-19T01:00:00.000Z',
      timezone: 'Asia/Shanghai',
    },
    confidence: 0.98,
    rationaleCodes: ['scheduled_reminder'],
  })
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
        id: 'chatcmpl-reminder-router',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'reminder-router-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: decision }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 6, completion_tokens: 8, total_tokens: 14 },
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
