import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('opens a real browser split and swaps it with the agent screen', async () => {
  const fixture = await startBrowserFixture()
  const address = fixture.server.address()
  if (address === null || typeof address === 'string') throw new Error('Browser fixture did not bind')
  const fixtureUrl = `http://127.0.0.1:${address.port}/`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-browser-e2e-'))
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
    await expect(page.getByTestId('agent-screen')).toBeVisible()
    await expect(page.getByTestId('browser-panel')).toHaveCount(0)

    await page.locator('.workspace-header').getByRole('button', { name: 'Open browser' }).click()
    const panel = page.getByTestId('browser-panel')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('agent-screen')).toHaveCount(0)
    await expect(page.getByTestId('workspace-shell')).toHaveClass(/browser-open/)

    const addressInput = page.getByRole('textbox', { name: 'Browser address' })
    await addressInput.fill(fixtureUrl)
    await addressInput.press('Enter')
    await expect(page.locator('.browser-page-title')).toContainText('Barn Browser Fixture', { timeout: 10_000 })
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState())).toMatchObject({
      open: true,
      visible: true,
      title: 'Barn Browser Fixture',
      url: fixtureUrl,
    })
    const captured = await page.evaluate(() => window.barn.browser.capture())
    expect(captured).toMatch(/^data:image\/png;base64,/)
    const nativeViews = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return window?.contentView.children.map((view) => ({
        bounds: view.getBounds(),
        visible: view.getVisible(),
      }))
    })
    expect(nativeViews?.some((view) => view.visible && view.bounds.width > 300 && view.bounds.height > 300)).toBe(true)
    await page.screenshot({ path: 'test-results/barn-browser-surface.png', fullPage: true })

    await panel.getByRole('button', { name: 'Close browser' }).click()
    await expect(page.getByTestId('browser-panel')).toHaveCount(0)
    const agentScreen = page.getByTestId('agent-screen')
    await expect(agentScreen).toBeVisible()
    await expect(agentScreen).toContainText('Barn Browser Fixture')
    await expect(agentScreen.locator('.agent-screen-kit-image')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState())).toMatchObject({
      open: false,
      visible: false,
    })
    await page.screenshot({ path: 'test-results/barn-agent-screen-live.png', fullPage: true })

    await expect(page.evaluate(() => window.barn.browser.navigate('file:///etc/passwd'))).rejects.toThrow(/not allowed/i)
    await expect(page.evaluate(() => window.barn.browser.navigate('http://169.254.169.254/latest/meta-data'))).rejects.toThrow(/not allowed/i)

    await agentScreen.locator('.agent-screen-kit-media-wrap').hover()
    await agentScreen.getByRole('button', { name: 'Open screen' }).click()
    await expect(page.getByTestId('browser-panel')).toBeVisible()
    await expect(page.getByTestId('agent-screen')).toHaveCount(0)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startBrowserFixture(): Promise<{ server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>Barn Browser Fixture</title></head><body><h1>Browser ready</h1><p>Real Electron browser content.</p></body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server }
}
