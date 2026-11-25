import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('routes a high-confidence side-effect request through the durable Task path', async () => {
  const server = await startModelServer('The requested message is ready for approval.')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-delegation-routing-e2e-'))
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
        id: 'delegation-provider',
        name: 'Delegation Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'delegation-model',
          name: 'Delegation Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'delegation-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'delegation-provider', modelId: 'delegation-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const request = 'Send an email to Alice with the project update.'
    const composer = page.getByLabel('Message Barn')
    await composer.fill(request)
    await composer.press('Enter')

    await expect(page.locator('.barn-thinking-indicator')).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.tasks.list()).length)).toBe(1)
    const task = await page.evaluate(async () => (await window.barn.tasks.list())[0])
    expect(task).toMatchObject({ title: request, origin: 'user' })
    expect(task?.prompt).toContain('Task goal:')
    expect(task?.prompt).toContain('Expected deliverable:')
    expect(task?.visiblePrompt).toBe(request)
    await expect(page.locator('.task-rail-card', { hasText: request })).toBeVisible()

    await expect.poll(async () => page.evaluate(async (taskId) => (await window.barn.tasks.get(taskId)).status, task!.id), { timeout: 15_000 }).toBe('completed')
    await expect(page.locator('.barn-thinking-indicator')).toHaveCount(0)
    await page.locator('.task-rail-card').click()
    await expect(page.locator('.task-detail-page')).toContainText('The requested message is ready for approval.')
    const thread = await page.evaluate(async () => (await window.barn.threads.getSnapshot()).messages)
    expect(thread).toHaveLength(2)
    expect(thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: request }),
      expect.objectContaining({
        role: 'assistant',
        content: 'The requested message is ready for approval.',
        metadata: expect.objectContaining({
          taskId: task!.id,
          taskResult: true,
          routerRequestId: expect.any(String),
        }),
      }),
    ]))
    expect(thread.some((message) => String(message.content).includes('queued'))).toBe(false)
    expect(thread.find((message) => message.role === 'user')?.content).not.toContain('Task contract:')
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startModelServer(text: string): Promise<Server> {
  let calls = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      calls++
      const content = calls === 1
        ? JSON.stringify({
            tool: 'task.create',
            arguments: {
              title: 'Send an email to Alice with the project update.',
              objective: 'Send an email to Alice with the approved project update.',
              deliverable: 'A sent email and confirmation receipt.',
              constraints: ['Use the approved project update.'],
              acceptanceCriteria: ['The requested message is ready for approval.'],
              forbiddenActions: ['Do not send without approval.'],
              risk: 'external_write',
              expectedArtifacts: [],
            },
            confidence: 0.98,
            rationaleCodes: ['e2e_task'],
          })
        : text
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: 'chatcmpl-delegation',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'delegation-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
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
