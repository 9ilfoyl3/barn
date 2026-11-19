import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('updates an existing recurring routine without showing Thinking Orbs', async () => {
  const modelServer = await startRoutineUpdateServer()
  const address = modelServer.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-routine-update-e2e-'))
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
        id: 'routine-update-provider',
        name: 'Routine Update Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'routine-update-model',
          name: 'Routine Update Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'routine-update-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'routine-update-provider', modelId: 'routine-update-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('给 Barn 发消息')
    await composer.fill('每天下午三点提醒我起来站一下')
    await composer.press('Enter')
    await expect(page.locator('.routine-card')).toHaveCount(0)
    await expect(page.locator('.barn-thinking-indicator')).toHaveCount(0)

    await composer.fill('不要三点提醒我了，每天下午四点提醒我起来站一下吧')
    await composer.press('Enter')
    await expect.poll(async () => page.evaluate(async () => {
      const task = (await window.barn.tasks.list()).find((entry) => entry.kind === 'reminder')
      return task === undefined ? null : {
        title: task.title,
        scheduledFor: task.scheduledFor,
        recurrence: task.recurrence,
        timezone: task.timezone,
        status: task.status,
      }
    })).toEqual({
      title: '每日16:00提醒：起来站一下',
      scheduledFor: '2026-11-20T08:00:00.000Z',
      recurrence: 'daily',
      timezone: 'Asia/Shanghai',
      status: 'queued',
    })
    await expect(page.locator('.routine-card')).toHaveCount(0)
    await expect(page.locator('.barn-thinking-indicator')).toHaveCount(0)
    await expect(page.locator('.chat-message.assistant').last()).toContainText('每天 16:00')
    await expect(page.locator('.task-rail-card')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/barn-routine-update.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startRoutineUpdateServer(): Promise<Server> {
  let calls = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      calls++
      const taskId = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0]
      const decision = calls === 1
        ? JSON.stringify({
            tool: 'schedule.create',
            arguments: {
              title: '每日15:00提醒：起来站一下',
              text: '每天下午三点提醒我起来站一下。',
              scheduledFor: '2026-11-20T07:00:00.000Z',
              timezone: 'Asia/Shanghai',
              recurrence: 'daily',
            },
            confidence: 0.98,
            rationaleCodes: ['create_daily_routine'],
          })
        : JSON.stringify({
            tool: 'routine.update',
            arguments: {
              taskId,
              title: '每日16:00提醒：起来站一下',
              text: '每天下午四点提醒我起来站一下。',
              scheduledFor: '2026-11-20T08:00:00.000Z',
              timezone: 'Asia/Shanghai',
              recurrence: 'daily',
            },
            confidence: 0.98,
            rationaleCodes: ['update_daily_routine'],
          })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-routine-update-${calls}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'routine-update-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: decision }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
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
