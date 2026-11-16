import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('creates, switches, and closes real browser tabs', async () => {
  const fixture = await startTabFixture()
  const address = fixture.server.address()
  if (address === null || typeof address === 'string') throw new Error('Tab fixture did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  const userData = await mkdtemp(join(tmpdir(), 'barn-browser-tabs-e2e-'))
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
    await page.locator('.workspace-header').getByRole('button', { name: 'Open browser' }).click()
    const panel = page.getByTestId('browser-panel')
    await expect(panel).toBeVisible()

    const addressInput = page.getByRole('textbox', { name: 'Browser address' })
    await addressInput.fill(`${origin}/one`)
    await addressInput.press('Enter')
    await expect(page.locator('.browser-page-title')).toContainText('Tab One', { timeout: 10_000 })

    await panel.getByRole('button', { name: 'New tab' }).click()
    await expect(panel.locator('.browser-tab')).toHaveCount(2)
    await addressInput.fill(`${origin}/two`)
    await addressInput.press('Enter')
    await expect(page.locator('.browser-page-title')).toContainText('Tab Two', { timeout: 10_000 })

    let state = await page.evaluate(() => window.barn.browser.getState())
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs.map((tab) => tab.title)).toEqual(expect.arrayContaining(['Tab One', 'Tab Two']))

    await panel.getByRole('tab', { name: /Tab One/ }).click()
    await expect(page.locator('.browser-page-title')).toContainText('Tab One')
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState().then((next) => next.url))).toContain('/one')

    await panel.getByRole('button', { name: 'Close Tab One' }).click()
    await expect(panel.locator('.browser-tab')).toHaveCount(1)
    await expect(page.locator('.browser-page-title')).toContainText('Tab Two')
    state = await page.evaluate(() => window.barn.browser.getState())
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.active).toBe(true)
    await page.screenshot({ path: 'test-results/barn-browser-tabs.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startTabFixture(): Promise<{ server: Server }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const title = path === '/two' ? 'Tab Two' : 'Tab One'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server }
}
