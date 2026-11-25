import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('shows diagnostics and runs local maintenance', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-diagnostics-e2e-'))
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
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeVisible()
    await expect(page.getByText('Database schema')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Agent Computer' })).toBeVisible()
    await expect(page.getByText('Built-in Browser')).toBeVisible()
    await expect(page.getByText('Secure VM')).toBeVisible()
    await expect(page.getByText('Your Computer')).toBeVisible()
    await page.getByRole('spinbutton', { name: 'Retention days' }).fill('30')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const retentionToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Retention setting saved.' })
    await expect(retentionToast).toBeVisible()
    await expect(retentionToast.locator('[data-close-button]')).toHaveCount(0)
    await page.waitForTimeout(500)
    const toastPosition = await retentionToast.evaluate((toast) => {
      const rect = toast.getBoundingClientRect()
      return { center: rect.left + rect.width / 2, top: rect.top, viewport: window.innerWidth }
    })
    expect(Math.abs(toastPosition.center - toastPosition.viewport / 2)).toBeLessThan(2)
    expect(toastPosition.top).toBeGreaterThanOrEqual(60)
    expect(toastPosition.top).toBeLessThan(100)
    await page.getByRole('button', { name: 'Run cleanup' }).click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Cleanup removed/ })).toBeVisible()
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/barn-diagnostics.png', fullPage: true })
  } finally {
    await app.close()
  }
})
