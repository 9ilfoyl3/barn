import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('renders the Comma-style Chinese settings layout with scroll edge blur', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-settings-visual-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'zh-CN',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.account-row').click()
    await page.getByRole('menuitem', { name: '设置' }).click()
    await expect(page.locator('#account-panel')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByRole('button', { name: '通用', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: '通用', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: '记忆', exact: true })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/barn-settings-general-zh.png', fullPage: true })

    await page.getByRole('button', { name: '记忆', exact: true }).click()
    await page.getByText('记忆运行设置').click()
    const scroll = page.locator('.settings-page-scroll')
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(page.locator('.settings-scroll-edge.top')).toHaveClass(/visible/)
    await page.screenshot({ path: 'test-results/barn-settings-memory-zh.png', fullPage: true })
  } finally {
    await app.close()
  }
})
