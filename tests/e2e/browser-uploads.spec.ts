import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { routerTaskDecisionJson } from './router-test-helpers'

test('uploads an authorized workspace file into a real file input', async () => {
  const fixture = await startUploadFixture()
  const fixtureAddress = fixture.server.address()
  if (fixtureAddress === null || typeof fixtureAddress === 'string') throw new Error('Upload fixture did not bind')
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`
  const modelServer = await startUploadModelServer(fixtureUrl)
  const modelAddress = modelServer.address()
  if (modelAddress === null || typeof modelAddress === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-browser-uploads-e2e-'))
  const uploadPath = join(userData, 'workspace', 'report.txt')
  await mkdir(join(userData, 'workspace'), { recursive: true })
  await writeFile(uploadPath, 'Barn upload fixture')
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
        id: 'upload-provider',
        name: 'Upload Provider',
        baseUrl: url,
        api: 'openai-responses',
        models: [{
          id: 'upload-model',
          name: 'Upload Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'upload-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'upload-provider', modelId: 'upload-model' })
    }, `http://127.0.0.1:${modelAddress.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Upload report.txt to the local page.')
    await composer.press('Enter')
    await expect(page.getByText('Upload completed.').last()).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState().then((state) => state.title))).toBe('File selected')
    const state = await page.evaluate(() => window.barn.browser.getState())
    expect(state.url).toBe(fixtureUrl)
    await expect(page.getByTestId('browser-panel')).toBeVisible()
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error === undefined ? resolve() : reject(error)))
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startUploadFixture(): Promise<{ server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Upload Page</title></head><body>
      <h1>Upload Page</h1>
      <input id="file" type="file" aria-label="Upload file" />
      <p id="result">No file selected</p>
      <script>
        document.getElementById('file').addEventListener('change', (event) => {
          const file = event.target.files[0]
          document.title = 'File selected'
          document.getElementById('result').textContent = file ? file.name : 'No file selected'
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

async function startUploadModelServer(fixtureUrl: string): Promise<Server> {
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
          'Upload report.txt to the local page',
          'Upload the authorized workspace file into the local file input.',
          'external_write',
        ))
      }
      if (requestCount === 2) return sendFunctionCall(response, 'browser_open', { url: fixtureUrl }, 'upload-open')
      if (requestCount === 3) return sendFunctionCall(response, 'browser_observe', {}, 'upload-observe')
      if (requestCount === 4) {
        const ref = refFromObservation(parsed, 'Upload file')
        return sendFunctionCall(response, 'browser_upload', {
          ref,
          path: 'report.txt',
        }, 'upload-file')
      }
      return sendTextResponse(response, 'Upload completed.')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

function refFromObservation(body: Record<string, unknown>, name: string): string {
  const strings: string[] = []
  collectStrings(body, strings)
  const observation = strings.find((value) => value.includes('"elements"') && value.includes('"ref"'))
  if (observation !== undefined) {
    const parsed = JSON.parse(observation) as { elements?: Array<{ ref?: string; name?: string }> }
    const ref = parsed.elements?.find((element) => element.name === name)?.ref
    if (ref !== undefined) return ref
  }
  return 'e1'
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
    id: 'message-upload-done',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  sendEvent(response, { type: 'response.created', response: { id: 'resp-upload-done', status: 'in_progress', output: [] } })
  sendEvent(response, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
  sendEvent(response, { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text })
  sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
  sendEvent(response, {
    type: 'response.completed',
    response: { id: 'resp-upload-done', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } },
  })
  response.end('data: [DONE]\n\n')
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
