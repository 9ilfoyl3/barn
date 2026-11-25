import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('configures Volcengine Ark and completes a Responses API call', async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = await startMockArkServer(requests)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock Ark server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/api/v3`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-ark-e2e-'))
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
    await page.locator('.account-row').click()
    await page.getByRole('menuitem', { name: /Models/i }).click()
    await page.getByRole('button', { name: 'Add provider' }).click()
    await page.getByRole('button', { name: /Volcengine Ark/i }).click()
    const reasoningCheckbox = page.getByLabel('Reasoning model')
    const checkboxBox = await reasoningCheckbox.boundingBox()
    expect(checkboxBox?.width ?? 100).toBeLessThanOrEqual(20)
    expect(checkboxBox?.height ?? 100).toBeLessThanOrEqual(20)
    await reasoningCheckbox.check()
    await expect(page.locator('.effort-config-option')).toHaveCount(6)
    await expect(page.getByRole('button', { name: 'High', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Max', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Max', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const baseUrlInput = page.getByLabel('Base URL')
    await baseUrlInput.focus()
    await baseUrlInput.fill('')
    await page.keyboard.type('not-a-url')
    await page.keyboard.press('Tab')
    await expect(page.getByText('Enter a valid URL')).toBeVisible()
    await expect(page.locator('.barn-input-field.is-err')).toBeVisible()
    await baseUrlInput.fill(baseUrl)
    await expect(page.locator('.barn-input-field.is-ok')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-ark-form.png', fullPage: true })
    await page.getByLabel('API key').fill('test-ark-key')
    await page.getByRole('button', { name: 'Save and test' }).click()

    await expect(page.getByText(/Connection succeeded/i)).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: 'test-results/barn-ark-settings.png', fullPage: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      model: 'deepseek-v4-1-flash-261017',
      stream: true,
    })
    expect(requests[0]).not.toHaveProperty('store')
    expect(requests[0]).not.toHaveProperty('prompt_cache_key')
    expect(requests[0]).not.toHaveProperty('prompt_cache_retention')
    expect(requests[0]).not.toHaveProperty('prompt_cache_options')

    await page.getByRole('button', { name: 'Edit provider' }).click()
    await expect(page.getByRole('heading', { name: 'Edit Volcengine Ark' })).toBeVisible()
    await expect(page.getByLabel('Provider ID')).toHaveAttribute('readonly', '')
    await page.getByLabel('Display name').fill('Volcengine Ark Edited')
    await page.getByLabel('Model name').fill('DeepSeek V4.1 Flash Edited')
    await page.getByLabel('Context window').fill('131072')
    await page.getByRole('button', { name: 'Add model' }).click()
    await page.getByLabel('Model ID').nth(1).fill('deepseek-lite')
    await page.getByLabel('Model name').nth(1).fill('DeepSeek Lite')
    await page.getByLabel('Context window').nth(1).fill('65536')
    await page.getByLabel('Max output').nth(1).fill('8192')
    await page.screenshot({ path: 'test-results/barn-ark-edit-form.png', fullPage: true })
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect.poll(() => requests.length).toBe(2)
    await expect(page.getByRole('heading', { name: 'Volcengine Ark Edited' })).toBeVisible()
    const editedModels = await page.evaluate(() => window.barn.models.getModels('volcengine-ark'))
    expect(editedModels.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      reasoningEfforts: model.reasoningEfforts,
    }))).toEqual([
      {
        id: 'deepseek-v4-1-flash-261017',
        name: 'DeepSeek V4.1 Flash Edited',
        contextWindow: 131_072,
        reasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'deepseek-lite',
        name: 'DeepSeek Lite',
        contextWindow: 65_536,
        reasoning: false,
        reasoningEfforts: [],
      },
    ])
    await page.screenshot({ path: 'test-results/barn-ark-edit.png', fullPage: true })

    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect(page.locator('.composer-model')).toContainText('DeepSeek V4.1 Flash Edited')
    await page.locator('.composer-model').click()
    await expect(page.locator('.model-picker-submenu')).toHaveCount(0)
    await page.locator('.model-picker-menu-row').first().hover()
    await expect(page.getByRole('option', { name: /DeepSeek Lite/ })).toBeVisible()
    await page.locator('.model-picker-menu-row').nth(1).hover()
    await expect(page.getByRole('slider', { name: 'Effort' })).toBeVisible()
    await expect(page.locator('.effort-slider-dot')).toHaveCount(4)
    await page.keyboard.press('Escape')
    const composer = page.getByLabel('Message Barn')
    await composer.fill('Hello Ark')
    await composer.press('Enter')

    await expect(page.getByRole('main').getByText('Ark says OK')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: 'test-results/barn-ark-chat.png', fullPage: true })
    expect(requests).toHaveLength(3)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startMockArkServer(requests: Array<Record<string, unknown>>): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/v3/responses') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as Record<string, unknown>
      requests.push(payload)
      const reply = requests.length <= 2
        ? 'OK'
        : JSON.stringify({
            tool: 'reply',
            arguments: { text: 'Ark says OK' },
            confidence: 0.99,
            rationaleCodes: ['e2e_direct_reply'],
          })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const item = {
        id: 'msg-1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: reply, annotations: [] }],
      }
      sendEvent(response, {
        type: 'response.created',
        response: { id: 'resp-1', status: 'in_progress', output: [] },
      })
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      })
      sendEvent(response, {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'msg-1',
        content_index: 0,
        delta: reply,
      })
      sendEvent(response, {
        type: 'response.output_item.done',
        output_index: 0,
        item,
      })
      sendEvent(response, {
        type: 'response.completed',
        response: {
          id: 'resp-1',
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
          },
        },
      })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
