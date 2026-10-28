import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('streams a multi-turn conversation through the Agent Worker', async () => {
  let requestCount = 0
  const server = await startMockModelServer(() => {
    requestCount++
    return `Barn reply ${requestCount}`
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-chat-e2e-'))
  const attachmentId = '9591d5dd-cd5d-497f-ab9a-255f015cbd2d'
  const attachmentPath = join(userData, 'workspace', `${attachmentId}-contract.pdf`)
  await mkdir(join(userData, 'workspace'), { recursive: true })
  await writeFile(attachmentPath, 'test attachment')
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'mock-provider',
        name: 'Mock Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'mock-model',
          name: 'Mock Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({
        providerId: 'mock-provider',
        apiKey: 'test-key',
      })
      await window.barn.models.setDefault({
        providerId: 'mock-provider',
        modelId: 'mock-model',
      })
    }, baseUrl)

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, attachmentPath)

    await page.getByRole('button', { name: /New session/i }).click()
    await expect(page.locator('.session-row')).toHaveCount(0)
    await page.getByRole('button', { name: 'Attach files' }).click()
    await expect(page.locator('.attachment-chip')).toContainText('contract.pdf')
    expect(await page.evaluate(() => window.barn.sessions.list())).toHaveLength(0)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Hello')
    await composer.press('Enter')

    await expect(page.getByText('Barn reply 1').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('main').getByText('Hello', { exact: true })).toBeVisible()
    await expect(page.locator('.message-attachment')).toContainText('contract.pdf')
    await expect(page.locator('.message-attachment')).not.toContainText(attachmentId)
    await expect(page.getByText(/Context \d+%/)).toBeVisible()
    await expect(page.getByText(attachmentPath, { exact: true })).toHaveCount(0)
    await expect(page.locator('.session-row')).toHaveCount(1)
    await expect(page.locator('.session-row.active')).toContainText('Hello')

    await composer.fill('Second turn')
    await composer.press('Enter')
    await expect(page.getByText('Barn reply 2').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('main').getByText('Second turn', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-desktop-chat.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

test('interleaves live thinking, tools, and content in event order', async () => {
  const mock = await startOrderedModelServer()
  const address = mock.server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-order-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (baseUrl) => {
      await window.barn.models.saveCustomProvider({
        id: 'ordered-provider',
        name: 'Ordered Provider',
        baseUrl,
        api: 'openai-responses',
        models: [{
          id: 'ordered-model',
          name: 'Ordered Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'ordered-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'ordered-provider', modelId: 'ordered-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    await page.getByRole('button', { name: /New session/i }).click()
    const composer = page.getByLabel('Message Barn')
    await composer.fill('Inspect the workspace.')
    await composer.press('Enter')

    await mock.secondStarted
    await expect.poll(() => page
      .locator('.live-turn .conversation-part')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-part'))))
      .toEqual(['tool-group', 'thinking'])
    await expect(page.locator('.live-turn .tool-group-summary')).toContainText('已查看目录')

    mock.release()
    await expect(page.getByText('The workspace looks good.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const finalParts = await page
      .locator('.chat-message.assistant .conversation-part')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-part')))
    expect(finalParts).toEqual(['tool-group', 'thinking', 'text'])

    const toolGroup = page.locator('.chat-message.assistant .tool-group')
    await expect(toolGroup.locator('.tool-group-summary')).toContainText('已查看目录')
    await expect(toolGroup.locator('.tool-row')).toHaveCount(0)
    await toolGroup.locator('.tool-group-summary').click()
    await expect(toolGroup.locator('.tool-row')).toHaveCount(1)
    await toolGroup.locator('.tool-row summary').click()
    const detail = toolGroup.locator('.tool-detail-scroll')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('List Dir')
    await expect(detail).toContainText('"path": "."')
    const detailStyle = await detail.evaluate((element) => ({
      maxHeight: getComputedStyle(element).maxHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))
    expect(detailStyle).toEqual({ maxHeight: '250px', overflowY: 'auto' })
    await page.screenshot({ path: 'test-results/barn-ordered-stream.png', fullPage: true })
  } finally {
    mock.release()
    await app.close()
    await new Promise<void>((resolve, reject) => mock.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startMockModelServer(nextReply: () => string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      const text = nextReply()
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-${text}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function startOrderedModelServer(): Promise<{
  server: Server
  secondStarted: Promise<void>
  release: () => void
}> {
  let requestCount = 0
  let notifySecondStarted: (() => void) | undefined
  let releaseSecond: (() => void) | undefined
  const secondStarted = new Promise<void>((resolve) => { notifySecondStarted = resolve })
  const released = new Promise<void>((resolve) => { releaseSecond = resolve })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', async () => {
      requestCount++
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (requestCount === 1) {
        sendResponseFunctionCall(response, 'list_dir', { path: '.' }, 'call-list')
        return
      }
      const reasoning = {
        id: 'reasoning-order',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'I inspected the workspace.' }],
      }
      sendEvent(response, {
        type: 'response.created',
        response: { id: 'resp-order', status: 'in_progress', output: [] },
      })
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...reasoning, summary: [] },
      })
      sendEvent(response, {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: reasoning.id,
        summary_index: 0,
        delta: 'I inspected the workspace.',
      })
      notifySecondStarted?.()
      await released
      sendEvent(response, {
        type: 'response.output_item.done',
        output_index: 0,
        item: reasoning,
      })
      const item = {
        id: 'message-order',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The workspace looks good.', annotations: [] }],
      }
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...item, status: 'in_progress', content: [] },
      })
      sendEvent(response, {
        type: 'response.output_text.delta',
        output_index: 1,
        item_id: item.id,
        content_index: 0,
        delta: 'The workspace looks good.',
      })
      sendEvent(response, { type: 'response.output_item.done', output_index: 1, item })
      sendEvent(response, {
        type: 'response.completed',
        response: {
          id: 'resp-order',
          status: 'completed',
          output: [reasoning, item],
          usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
        },
      })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    secondStarted,
    release: () => releaseSecond?.(),
  }
}

function sendResponseFunctionCall(
  response: import('node:http').ServerResponse,
  name: string,
  args: Record<string, unknown>,
  callId: string,
): void {
  const item = {
    id: `fc-${callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  }
  sendEvent(response, {
    type: 'response.created',
    response: { id: `resp-${callId}`, status: 'in_progress', output: [] },
  })
  sendEvent(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', arguments: '' },
  })
  sendEvent(response, {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: item.id,
    delta: item.arguments,
  })
  sendEvent(response, {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: item.id,
    arguments: item.arguments,
  })
  sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
  sendEvent(response, {
    type: 'response.completed',
    response: {
      id: `resp-${callId}`,
      status: 'completed',
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  })
  response.end('data: [DONE]\n\n')
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
