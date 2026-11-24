import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('uses semantic browser tools to fill and submit a real page', async () => {
  const fixture = await startFormFixture()
  const fixtureAddress = fixture.server.address()
  if (fixtureAddress === null || typeof fixtureAddress === 'string') throw new Error('Form fixture did not bind')
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`

  const requests: Array<Record<string, unknown>> = []
  const modelServer = await startBrowserModelServer(fixtureUrl, requests)
  const modelAddress = modelServer.address()
  if (modelAddress === null || typeof modelAddress === 'string') throw new Error('Model server did not bind')
  const baseUrl = `http://127.0.0.1:${modelAddress.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-browser-tools-e2e-'))
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
        id: 'browser-tools-provider',
        name: 'Browser Tools Provider',
        baseUrl: url,
        api: 'openai-responses',
        models: [{
          id: 'browser-tools-model',
          name: 'Browser Tools Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text', 'image'],
        }],
      })
      await window.barn.models.saveCredential({
        providerId: 'browser-tools-provider',
        apiKey: 'test-key',
      })
      await window.barn.models.setDefault({
        providerId: 'browser-tools-provider',
        modelId: 'browser-tools-model',
      })
    }, baseUrl)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Fill the local form with Ada and submit it.')
    await composer.press('Enter')

    const mainApproval = page.locator('.task-result-notice .task-approval-card').filter({ hasText: 'Submit a form on 127.0.0.1' })
    await expect(mainApproval).toBeVisible({ timeout: 15_000 })
    await expect(mainApproval).toContainText('Waiting for your decision')
    await mainApproval.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.locator('.background-browser-approval')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(async () => (await window.barn.tasks.list())[0]?.status), { timeout: 20_000 }).toBe('completed')
    await expect(page.locator('.task-result-notice .task-approval-card').filter({ hasText: 'Submit a form on 127.0.0.1' }))
      .toContainText('Approved')
    await expect(page.getByTestId('browser-panel')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState())).toMatchObject({
      open: false,
      visible: false,
    })
    expect(requests.length).toBeGreaterThanOrEqual(7)

    const taskCard = page.locator('.task-rail-card', { hasText: 'Fill and submit the local browser form' }).last()
    await expect(taskCard).toContainText('Completed')
    await taskCard.click()
    await expect(page.locator('.task-detail-page')).toContainText('Browser task completed.')
    await page.screenshot({ path: 'test-results/barn-browser-task-detail.png', fullPage: true })

    await page.evaluate(async (url) => { await window.barn.browser.open(url) }, fixtureUrl)
    await expect.poll(async () => page.evaluate(async () => (await window.barn.browser.getState()).title)).toBe('Browser Form')
    const userBrowser = await page.evaluate(() => window.barn.browser.getState())
    expect(userBrowser.url).toBe(fixtureUrl)
    await page.evaluate(async () => { await window.barn.browser.close() })

    await page.getByRole('button', { name: 'Home' }).click()
    await expect(page.getByTestId('agent-screen')).toHaveCount(0)
    await expect(page.locator('.workspace-body')).toHaveClass(/secretary-home/)
    await expect(page.locator('.today-home-column')).toBeVisible()
    await expect(page.locator('.conversation-view')).toBeVisible()
    await expect(page.locator('.task-rail')).toBeVisible()

    const layout = await page.evaluate(() => {
      const routines = document.querySelector('.today-home-column')!.getBoundingClientRect()
      const conversation = document.querySelector('.conversation-view')!.getBoundingClientRect()
      const tasks = document.querySelector('.task-rail')!.getBoundingClientRect()
      const workspace = document.querySelector('.workspace-body')!.getBoundingClientRect()
      return {
        routinesRight: routines.right,
        conversationLeft: conversation.left,
        conversationRight: conversation.right,
        tasksLeft: tasks.left,
        workspaceRight: workspace.right,
      }
    })
    expect(layout.routinesRight).toBeLessThanOrEqual(layout.conversationLeft)
    expect(layout.conversationRight).toBeLessThanOrEqual(layout.tasksLeft)
    expect(layout.workspaceRight).toBeGreaterThanOrEqual(layout.conversationRight)
    await page.screenshot({ path: 'test-results/barn-browser-background-home.png', fullPage: true })

    await page.locator('.workspace-header').getByRole('button', { name: 'Open browser' }).click()
    await expect(page.getByTestId('browser-panel')).toBeVisible()
    await expect(page.getByTestId('agent-screen')).toHaveCount(0)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error === undefined ? resolve() : reject(error)))
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startFormFixture(): Promise<{ server: Server }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/done') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Submitted</title></head><body><h1>Submitted</h1><p>${url.searchParams.get('name') ?? ''}</p></body></html>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Browser Form</title></head><body>
      <h1>Browser Form</h1>
      <form action="/done" method="get">
        <label for="name">Name</label>
        <input id="name" name="name" aria-label="Name" />
        <button type="submit">Submit</button>
      </form>
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server }
}

async function startBrowserModelServer(fixtureUrl: string, requests: Array<Record<string, unknown>>): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      requests.push(parsed)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (requests.length === 1) {
        sendTextResponse(response, JSON.stringify({
          tool: 'task.create',
          arguments: {
            title: 'Fill and submit the local browser form',
            objective: 'Fill the local form with Ada and submit it.',
            deliverable: 'The submitted form page and confirmation.',
            constraints: ['Use the built-in browser.'],
            acceptanceCriteria: ['The form submits with Ada.'],
            forbiddenActions: ['Do not submit unrelated forms.'],
            risk: 'external_write',
            expectedArtifacts: [],
          },
          confidence: 0.98,
          rationaleCodes: ['e2e_browser_task'],
        }))
        return
      }
      if (requests.length === 2) {
        sendFunctionCall(response, 'browser_open', { url: fixtureUrl }, 'call-open')
        return
      }
      if (requests.length === 3) {
        sendFunctionCall(response, 'browser_observe', {}, 'call-observe')
        return
      }
      if (requests.length === 4) {
        const refs = refsFromObservation(parsed)
        sendFunctionCall(response, 'browser_act', {
          actions: [
            { type: 'type', ref: refs.name, text: 'Ada' },
            { type: 'click', ref: refs.submit },
          ],
        }, 'call-act')
        return
      }
      if (requests.length === 5) {
        sendFunctionCall(response, 'browser_read', { maxChars: 2_000 }, 'call-read')
        return
      }
      if (requests.length === 6) {
        sendFunctionCall(response, 'browser_screenshot', {}, 'call-screenshot')
        return
      }
      sendTextResponse(response, 'Browser task completed.')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

function refsFromObservation(body: Record<string, unknown>): { name: string; submit: string } {
  const strings: string[] = []
  collectStrings(body, strings)
  const observation = strings.find((value) => value.includes('"elements"') && value.includes('"ref"'))
  if (observation !== undefined) {
    const parsed = JSON.parse(observation) as { elements?: Array<{ ref?: string; name?: string }> }
    const name = parsed.elements?.find((element) => element.name === 'Name')?.ref
    const submit = parsed.elements?.find((element) => element.name === 'Submit')?.ref
    if (name !== undefined && submit !== undefined) return { name, submit }
  }
  return { name: 'e1', submit: 'e2' }
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, output)
  }
}

function sendFunctionCall(
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

function sendTextResponse(response: import('node:http').ServerResponse, text: string): void {
  const item = {
    id: 'message-browser-done',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  sendEvent(response, {
    type: 'response.created',
    response: { id: 'resp-browser-done', status: 'in_progress', output: [] },
  })
  sendEvent(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  })
  sendEvent(response, {
    type: 'response.output_text.delta',
    output_index: 0,
    item_id: item.id,
    content_index: 0,
    delta: text,
  })
  sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
  sendEvent(response, {
    type: 'response.completed',
    response: {
      id: 'resp-browser-done',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    },
  })
  response.end('data: [DONE]\n\n')
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
