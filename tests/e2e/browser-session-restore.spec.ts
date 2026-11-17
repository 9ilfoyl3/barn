import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('restores browser tabs and the active tab after restarting Barn', async () => {
  test.setTimeout(60_000)
  const fixture = await startRestoreFixture()
  const address = fixture.server.address()
  if (address === null || typeof address === 'string') throw new Error('Restore fixture did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  const userData = await mkdtemp(join(tmpdir(), 'barn-browser-restore-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const launch = (): ReturnType<typeof electron.launch> => electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
    },
  })

  const first = await launch()
  try {
    const page = await first.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.workspace-header').getByRole('button', { name: 'Open browser' }).click()
    const input = page.getByRole('textbox', { name: 'Browser address' })
    await input.fill(`${origin}/one`)
    await input.press('Enter')
    await expect(page.locator('.browser-tab.active .browser-tab-select')).toContainText('Restore One', { timeout: 10_000 })
    await page.getByTestId('browser-panel').getByRole('button', { name: 'New tab' }).click()
    await input.fill(`${origin}/two`)
    await input.press('Enter')
    await expect(page.locator('.browser-tab.active .browser-tab-select')).toContainText('Restore Two', { timeout: 10_000 })
    await expect.poll(async () => page.evaluate(() => window.barn.browser.getState().then((state) => state.tabs.length))).toBe(2)
  } finally {
    await first.close()
  }

  const second = await launch()
  try {
    const page = await second.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.workspace-header').getByRole('button', { name: 'Open browser' }).click()
    await expect(page.getByTestId('browser-panel').locator('.browser-tab')).toHaveCount(2)
    await expect(page.locator('.browser-tab.active .browser-tab-select')).toContainText('Restore Two', { timeout: 10_000 })
    const state = await page.evaluate(() => window.barn.browser.getState())
    expect(state.tabs.map((tab) => tab.title)).toEqual(expect.arrayContaining(['Restore One', 'Restore Two']))
    expect(state.tabs.find((tab) => tab.active)?.title).toBe('Restore Two')
    await page.screenshot({ path: 'test-results/barn-browser-restored.png', fullPage: true })
  } finally {
    await second.close()
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startRestoreFixture(): Promise<{ server: Server }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const title = path === '/two' ? 'Restore Two' : 'Restore One'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server }
}
