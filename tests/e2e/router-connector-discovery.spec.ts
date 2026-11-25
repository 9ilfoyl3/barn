import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('answers a connector inventory question without creating a Task', async () => {
  const requests: Array<Record<string, unknown>> = []
  const model = await startRouterConnectorModelServer(requests)
  const address = model.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-router-connector-e2e-'))
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
    await page.evaluate(async (baseUrl) => {
      await window.barn.models.saveCustomProvider({
        id: 'connector-router-provider',
        name: 'Connector Router Provider',
        baseUrl,
        api: 'openai-completions',
        models: [{
          id: 'connector-router-model',
          name: 'Connector Router Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({
        providerId: 'connector-router-provider',
        apiKey: 'test-key',
      })
      await window.barn.models.setDefault({
        providerId: 'connector-router-provider',
        modelId: 'connector-router-model',
      })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('What connectors are configured?')
    await composer.press('Enter')

    await expect(page.getByText('No connectors are configured.', { exact: true })).toBeVisible({ timeout: 15_000 })
    expect(requests).toHaveLength(2)
    expect(await page.evaluate(() => window.barn.tasks.list())).toEqual([])
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => model.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startRouterConnectorModelServer(requests: Array<Record<string, unknown>>): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as Record<string, unknown>
      requests.push(payload)
      if (requests.length === 1) {
        sendToolCall(response, 'call', {
          tool: 'connector_list',
          params: {},
        })
        return
      }
      sendToolCall(response, 'route_decision', {
        tool: 'reply',
        arguments: { text: 'No connectors are configured.' },
        confidence: 0.99,
        rationaleCodes: ['direct_connector_inventory'],
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

function sendToolCall(response: ServerResponse, name: string, args: Record<string, unknown>): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const base = {
    id: 'chatcmpl-router-connector',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'connector-router-model',
  }
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}
