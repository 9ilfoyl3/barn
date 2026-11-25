import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('routes an active Task-detail follow-up directly to its Worker', async () => {
  const model = await startActiveFollowUpServer()
  const address = model.server.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-active-followup-e2e-'))
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
        id: 'active-followup-provider',
        name: 'Active Follow-up Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'active-followup-model',
          name: 'Active Follow-up Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'active-followup-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'active-followup-provider', modelId: 'active-followup-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Prepare a long task.')
    await composer.press('Enter')
    await expect.poll(async () => page.evaluate(async () => window.barn.tasks.list()), {
      timeout: 15_000,
    }).toHaveLength(1)
    const task = (await page.evaluate(() => window.barn.tasks.list()))[0]!
    await expect.poll(() => model.workerCalls(), { timeout: 15_000 }).toBe(1)

    await page.locator('.task-nav-button').click()
    await page.locator('.task-row', { hasText: 'Long task' })
      .getByRole('button', { name: 'View details: Long task', exact: true })
      .click()
    const detail = page.locator('.task-detail-page')
    const taskComposer = detail.getByRole('textbox', { name: 'Message task agent' })
    await taskComposer.fill('Use the second source.')
    await taskComposer.press('Enter')

    await expect.poll(async () => page.evaluate(
      (taskId) => window.barn.tasks.get(taskId).then((current) => current.status),
      task.id,
    ), { timeout: 15_000 }).toBe('completed')
    expect(model.workerCalls()).toBe(2)
    expect(model.taskRouterCalls()).toBe(0)
    await expect(detail).toContainText('Follow-up completed.')
  } finally {
    model.release()
    await app.close()
    await new Promise<void>((resolve, reject) => model.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startActiveFollowUpServer(): Promise<{
  server: Server
  workerCalls: () => number
  taskRouterCalls: () => number
  release: () => void
}> {
  let workerCalls = 0
  let taskRouterCalls = 0
  const held = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (body.includes("You are Barn's Task Router")) {
        taskRouterCalls += 1
        sendText(response, JSON.stringify({
          tool: 'worker.dispatch',
          arguments: {},
          confidence: 0.99,
          rationaleCodes: ['unexpected_task_router'],
        }))
        return
      }
      if (body.includes("You are Barn's Router")) {
        sendText(response, JSON.stringify({
          tool: 'task.create',
          arguments: {
            title: 'Long task',
            objective: 'Prepare a long-running task result.',
          },
          confidence: 0.99,
          rationaleCodes: ['e2e_long_task'],
        }))
        return
      }

      workerCalls += 1
      if (workerCalls === 1) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        held.add(response)
        response.on('close', () => held.delete(response))
        return
      }
      sendText(response, 'Follow-up completed.')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    server,
    workerCalls: () => workerCalls,
    taskRouterCalls: () => taskRouterCalls,
    release: () => {
      for (const response of held) response.end()
      held.clear()
    },
  }
}

function sendText(response: ServerResponse, text: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-active-followup',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'active-followup-model',
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
