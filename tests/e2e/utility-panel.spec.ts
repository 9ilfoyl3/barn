import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('opens a sandboxed terminal from the browser new tab page', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-terminal-e2e-'))
  const app = await launchApp(userData)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openBrowser(page)
    await page.getByTestId('browser-panel').getByRole('button', { name: 'Terminal', exact: true }).click()
    const panel = page.getByTestId('utility-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('tab', { name: 'Terminal' })).toBeVisible()
    const command = panel.getByRole('textbox', { name: 'Terminal command' })
    await command.fill('pwd')
    await command.press('Enter')
    await expect(panel.locator('.terminal-output')).toContainText('/workspace', { timeout: 15_000 })
    await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)
    await page.screenshot({ path: 'test-results/barn-terminal-panel.png', fullPage: true })
  } finally {
    await app.close()
  }
})

test('opens multiple independent side chats and keeps them out of the main session list', async () => {
  const server = await startMockModelServer('Side chat reply')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock model server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-side-chat-e2e-'))
  const app = await launchApp(userData)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'side-chat-provider',
        name: 'Side Chat Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'side-chat-model',
          name: 'Side Chat Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'side-chat-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'side-chat-provider', modelId: 'side-chat-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    await openBrowser(page)
    await page.getByTestId('browser-panel').getByRole('button', { name: 'Side chat', exact: true }).click()
    const panel = page.getByTestId('utility-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.utility-tab')).toHaveCount(1)

    const composer = panel.getByRole('textbox', { name: 'Side chat message' })
    await expect(composer).toBeEnabled()
    await composer.fill('Hello in a side chat')
    await composer.press('Enter')
    await expect(panel.getByText('Side chat reply').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.session-row')).toHaveCount(0)

    await panel.getByRole('button', { name: 'New side chat' }).click()
    await expect(panel.locator('.utility-tab')).toHaveCount(2)
    await expect(panel.getByRole('tab', { name: 'Side chat 2' })).toHaveAttribute('aria-selected', 'true')
    await panel.getByRole('tab', { name: 'Side chat', exact: true }).click()
    await expect(panel.getByText('Side chat reply').last()).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-side-chats.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function launchApp(userData: string): Promise<Awaited<ReturnType<typeof electron.launch>>> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
    },
  })
}

async function openBrowser(page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>): Promise<void> {
  await page.locator('.workspace-header .browser-toggle').click()
  await expect(page.getByTestId('browser-panel')).toBeVisible()
}

async function startMockModelServer(text: string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: 'chatcmpl-side-chat',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'side-chat-model',
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}
