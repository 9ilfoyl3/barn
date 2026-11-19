import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('reroutes an active Task in place and keeps Worker progress in the Task detail page', async () => {
  const model = await startRerouteModelServer()
  const address = model.server.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-reroute-e2e-'))
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
        id: 'reroute-provider',
        name: 'Reroute Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'reroute-model',
          name: 'Reroute Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'reroute-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'reroute-provider', modelId: 'reroute-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Search recent news on Xinhua.')
    await composer.press('Enter')

    await expect.poll(async () => {
      const tasks = await page.evaluate(async () => window.barn.tasks.list())
      return tasks.find((entry) => entry.title === 'News scan')?.status
    }, { timeout: 15_000 }).toBe('running')
    const task = await page.evaluate(async () => {
      const current = (await window.barn.tasks.list()).find((entry) => entry.title === 'News scan')
      if (current === undefined) throw new Error('News scan Task was not created')
      return { id: current.id, status: current.status, sessionId: current.sessionId }
    })
    expect(task.sessionId).toBeDefined()
    const firstSessionId = task.sessionId

    await expect.poll(() => model.workerStarted(), { timeout: 15_000 }).toBe(1)
    await expect.poll(async () => page.evaluate(async (taskId) => {
      const current = await window.barn.tasks.get(taskId)
      return current.status
    }, task.id), { timeout: 15_000 }).toBe('running')

    await composer.fill('从百度上看新闻，不要从新华网看')
    await composer.press('Enter')
    await expect(page.getByLabel('User message').getByText('从百度上看新闻，不要从新华网看', { exact: true })).toBeVisible()
    await expect(page.locator('.barn-thinking-indicator')).toBeVisible()
    await expect(page.getByText('Updated “News scan” and requeued it for execution.')).toHaveCount(0)

    await expect.poll(async () => page.evaluate(async (taskId) => {
      const current = await window.barn.tasks.get(taskId)
      return current.status
    }, task.id), { timeout: 15_000 }).toBe('completed')
    await expect.poll(() => model.workerStarted(), { timeout: 15_000 }).toBe(2)

    const result = await page.evaluate(async (taskId) => {
      const current = await window.barn.tasks.get(taskId)
      const sessions = await window.barn.sessions.list()
      const messages = await window.barn.threads.getSnapshot()
      return {
        task: current,
        sessions,
        messages: messages.messages,
      }
    }, task.id)
    expect(result.task.sessionId).toBeDefined()
    expect(result.task.sessionId).not.toBe(firstSessionId)
    expect(result.sessions).toHaveLength(2)
    expect(model.workerPrompts().at(-1)).toContain('Baidu')
    expect(result.messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Baidu news result'))).toBe(true)
    expect(result.messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('requeued it for execution'))).toBe(false)
    await page.waitForTimeout(200)
    await page.screenshot({ path: 'test-results/barn-task-reroute-result.png', fullPage: true })

    await page.locator('.task-rail-card', { hasText: 'News scan' }).click()
    await expect(page.locator('.task-detail-page')).toContainText('Baidu news result')
    await expect(page.locator('.task-detail-page')).not.toContainText('Xinhua news result')
    await page.screenshot({ path: 'test-results/barn-task-reroute.png', fullPage: true })
  } finally {
    model.releaseFirst()
    await app.close()
    await new Promise<void>((resolve, reject) => model.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startRerouteModelServer(): Promise<{
  server: Server
  workerStarted: () => number
  workerPrompts: () => string[]
  releaseFirst: () => void
}> {
  let workerStarted = 0
  const workerPrompts: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (body.includes("You are Barn's Router")) {
        const activeTasks = extractActiveTasks(body)
        const context = extractRouterContext(body)
        const userText = typeof context?.userMessage === 'string' ? context.userMessage : ''
        if (activeTasks.length > 0 && userText.includes('百度')) {
          const taskId = activeTasks[0]?.id
          if (taskId === undefined) throw new Error('Router active task id missing')
          sendText(response, JSON.stringify({
            tool: 'task.update',
            arguments: {
              taskId,
              instruction: 'Use Baidu instead of Xinhua.',
            },
            confidence: 0.98,
            rationaleCodes: ['e2e_reroute'],
          }))
          return
        }
        sendText(response, JSON.stringify({
          tool: 'task.create',
          arguments: {
            title: 'News scan',
            objective: 'Search recent news on Xinhua and summarize the result.',
            deliverable: 'A concise news summary.',
            constraints: ['Use a search source.'],
            acceptanceCriteria: ['The summary states the source and key headlines.'],
            forbiddenActions: [],
            risk: 'none',
            expectedArtifacts: [],
          },
          confidence: 0.98,
          rationaleCodes: ['e2e_news_task'],
        }))
        return
      }

      workerStarted += 1
      workerPrompts.push(body)
      if (workerStarted === 1) {
        void firstGate.then(() => {
          if (response.destroyed) return
          sendText(response, 'Xinhua news result')
        })
        return
      }
      sendText(response, 'Baidu news result')
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
    releaseFirst: () => releaseFirst(),
  }
}

function extractRouterContext(body: string): Record<string, unknown> | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return undefined
  }
  for (const value of collectStrings(payload)) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      if (Array.isArray(parsed.activeTasks) && typeof parsed.userMessage === 'string') return parsed
    } catch {
      // Not the Router's context payload.
    }
  }
  return undefined
}

function extractActiveTasks(body: string): Array<{ id?: string }> {
  return (extractRouterContext(body)?.activeTasks as Array<{ id?: string }> | undefined) ?? []
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings)
  }
  return []
}

function sendText(response: import('node:http').ServerResponse, text: string): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-reroute',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'reroute-model',
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
