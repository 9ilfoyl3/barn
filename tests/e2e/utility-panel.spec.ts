import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('opens a real sandboxed PTY with tab completion and control keys', async () => {
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
    const xterm = panel.locator('.xterm')
    await expect(xterm).toBeVisible()
    await xterm.click()
    await expect(panel.locator('.xterm-rows')).toContainText('→ barn', { timeout: 15_000 })

    await page.keyboard.type('ls pack')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(panel.locator('.xterm-rows')).toContainText('package.json', { timeout: 15_000 })

    await page.keyboard.type('sleep 5')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(250)
    await page.keyboard.press('Control+C')
    await page.keyboard.type('echo pty-ready')
    await page.keyboard.press('Enter')
    await expect(panel.locator('.xterm-rows')).toContainText('pty-ready', { timeout: 15_000 })
    await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)
    await page.screenshot({ path: 'test-results/barn-terminal-panel.png', fullPage: true })
  } finally {
    await app.close()
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
