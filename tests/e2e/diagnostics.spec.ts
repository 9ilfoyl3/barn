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
    await page.getByRole('menuitem', { name: 'Diagnostics' }).click()
    const dialog = page.getByRole('dialog', { name: 'Diagnostics' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Database schema')
    await expect(dialog.getByRole('heading', { name: 'Agent Computer' })).toBeVisible()
    await expect(dialog).toContainText('Built-in Browser')
    await expect(dialog).toContainText('Secure VM')
    await expect(dialog).toContainText('Your Computer')
    await expect(dialog).toContainText('1')
    await dialog.getByRole('spinbutton', { name: 'Retention days' }).fill('30')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
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
    await dialog.getByRole('button', { name: 'Run cleanup' }).click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Cleanup removed/ })).toBeVisible()

    await expect(dialog.getByRole('heading', { name: 'Agent memory' })).toBeVisible()
    await expect(dialog.getByText('No memories yet.')).toBeVisible()
    const memorySwitch = dialog.getByRole('switch', { name: /Enable agent memory/ })
    await expect(memorySwitch).not.toBeChecked()
    await memorySwitch.check()
    await dialog.getByRole('button', { name: 'Save memory settings' }).click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Memory settings saved.' })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.barn.memory.getSettings()).enabled)).toBe(true)
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/barn-diagnostics.png', fullPage: true })
  } finally {
    await app.close()
  }
})
