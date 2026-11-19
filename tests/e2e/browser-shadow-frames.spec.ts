import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { routerTaskDecisionJson } from './router-test-helpers'

test('observes and acts inside open Shadow DOM and same-origin iframes', async () => {
  const fixture = await startNestedFixture()
  const fixtureAddress = fixture.server.address()
  if (fixtureAddress === null || typeof fixtureAddress === 'string') throw new Error('Nested fixture did not bind')
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`
  const modelServer = await startNestedModelServer(fixtureUrl)
  const modelAddress = modelServer.address()
  if (modelAddress === null || typeof modelAddress === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-browser-nested-e2e-'))
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
        id: 'nested-provider',
        name: 'Nested Provider',
        baseUrl: url,
        api: 'openai-responses',
        models: [{
          id: 'nested-model',
          name: 'Nested Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'nested-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'nested-provider', modelId: 'nested-model' })
    }, `http://127.0.0.1:${modelAddress.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Fill controls inside the nested page regions.')
    await composer.press('Enter')
    await expect.poll(async () => page.evaluate(async () => (await window.barn.tasks.list())[0]?.status), { timeout: 20_000 }).toBe('completed')
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState())).toMatchObject({ open: false, visible: false })
    await expect(page.getByTestId('browser-panel')).toHaveCount(0)
    await page.locator('.task-rail-card').click()
    await expect(page.locator('.task-detail-page')).toContainText('Nested action completed.')
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error === undefined ? resolve() : reject(error)))
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startNestedFixture(): Promise<{ server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Nested Page</title></head><body>
      <h1>Nested Page</h1>
      <div id="shadow-host"></div>
      <iframe id="frame" srcdoc='<input aria-label="Frame note"><button type="button">Frame action</button><script>document.querySelector("button").addEventListener("click", () => { const shadowValue = parent.document.body.dataset.shadow ?? ""; const frameValue = document.querySelector("input").value; parent.document.title = "Shadow:" + shadowValue + " / Frame:" + frameValue })</script>'></iframe>
      <script>
        const host = document.getElementById('shadow-host')
        const root = host.attachShadow({ mode: 'open' })
        root.innerHTML = '<input aria-label="Shadow name"><button type="button">Shadow action</button>'
        root.querySelector('button').addEventListener('click', () => {
          document.querySelector('#frame').contentDocument.body.dataset.shadowValue = root.querySelector('input').value
          document.body.dataset.shadow = root.querySelector('input').value
        })
      </script>
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server }
}

async function startNestedModelServer(fixtureUrl: string): Promise<Server> {
  let requestCount = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requestCount += 1
      const parsed = JSON.parse(body) as Record<string, unknown>
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (requestCount === 1) {
        return sendTextResponse(response, routerTaskDecisionJson(
          'Fill nested browser controls',
          'Fill controls inside the open Shadow DOM and same-origin iframe.',
          'external_write',
        ))
      }
      if (requestCount === 2) return sendFunctionCall(response, 'browser_open', { url: fixtureUrl }, 'nested-open')
      if (requestCount === 3) return sendFunctionCall(response, 'browser_observe', {}, 'nested-observe')
      if (requestCount === 4) {
        const refs = refsFromObservation(parsed)
        return sendFunctionCall(response, 'browser_act', {
          actions: [
            { type: 'type', ref: refs.shadowName, text: 'Ada' },
            { type: 'click', ref: refs.shadowAction },
            { type: 'type', ref: refs.frameNote, text: 'Hello' },
            { type: 'click', ref: refs.frameAction },
          ],
        }, 'nested-act')
      }
      return sendTextResponse(response, 'Nested action completed.')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

function refsFromObservation(body: Record<string, unknown>): {
  shadowName: string
  shadowAction: string
  frameNote: string
  frameAction: string
} {
  const strings: string[] = []
  collectStrings(body, strings)
  const observation = strings.find((value) => value.includes('"elements"') && value.includes('"ref"'))
  if (observation === undefined) throw new Error('Nested observation was not present in the model request')
  const parsed = JSON.parse(observation) as { elements?: Array<{ ref?: string; name?: string }> }
  const find = (name: string): string => {
    const ref = parsed.elements?.find((element) => element.name === name)?.ref
    if (ref === undefined) throw new Error(`Missing nested ref: ${name}`)
    return ref
  }
  return {
    shadowName: find('Shadow name'),
    shadowAction: find('Shadow action'),
    frameNote: find('Frame note'),
    frameAction: find('Frame action'),
  }
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

function sendFunctionCall(response: import('node:http').ServerResponse, name: string, args: Record<string, unknown>, callId: string): void {
  const item = {
    id: `fc-${callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  }
  sendEvent(response, { type: 'response.created', response: { id: `resp-${callId}`, status: 'in_progress', output: [] } })
  sendEvent(response, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } })
  sendEvent(response, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments })
  sendEvent(response, { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments })
  sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
  sendEvent(response, {
    type: 'response.completed',
    response: { id: `resp-${callId}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
  })
  response.end('data: [DONE]\n\n')
}

function sendTextResponse(response: import('node:http').ServerResponse, text: string): void {
  const item = {
    id: 'message-nested-done',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  sendEvent(response, { type: 'response.created', response: { id: 'resp-nested-done', status: 'in_progress', output: [] } })
  sendEvent(response, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
  sendEvent(response, { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text })
  sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
  sendEvent(response, {
    type: 'response.completed',
    response: { id: 'resp-nested-done', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } },
  })
  response.end('data: [DONE]\n\n')
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
