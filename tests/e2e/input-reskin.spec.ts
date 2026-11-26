import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('shared Input keeps states and layout in dark and narrow layouts', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-input-reskin-'))
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
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Models', exact: true }).click()
    await page.getByRole('button', { name: 'Add provider' }).click()
    await page.getByRole('button', { name: 'Custom provider', exact: true }).click()
    await page.getByRole('button', { name: /Volcengine Ark/i }).click()

    const baseUrl = page.getByLabel('Base URL')
    await baseUrl.fill('not-a-url')
    await page.keyboard.press('Tab')
    await expect(page.getByText('Enter a valid URL')).toBeVisible()
    await expect(page.locator('.barn-input-field[data-state="error"]')).toBeVisible()
    await baseUrl.fill('https://gateway.example/v1')
    await expect(page.locator('.barn-input-field[data-state="success"]')).toBeVisible()

    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: 'test-results/barn-input-dark.png', fullPage: true })

    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(baseUrl).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await page.screenshot({ path: 'test-results/barn-input-narrow.png', fullPage: true })
  } finally {
    await app.close()
  }
})
