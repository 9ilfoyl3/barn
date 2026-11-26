import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('refactored settings manages MEMORY.md and USER.md from the memory section', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-settings-memory-e2e-'))
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
    await expect(page.locator('#account-panel')).toHaveAttribute('aria-hidden', 'true')

    await expect(page.getByRole('button', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/barn-settings-general.png', fullPage: true })
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Memory', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('tab', { name: 'Memory', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.memory-document-tabs [data-tabs-indicator]')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: 'User portrait' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Memory statistics' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'MEMORY.md' })).toHaveAttribute('placeholder', 'Write long-term memory in Markdown…')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/barn-settings-memory-empty.png', fullPage: true })

    await page.getByRole('button', { name: 'Adjust limit' }).click()
    const limitButtons = page.locator('.memory-limit-editor button')
    await expect(limitButtons).toHaveCount(2)
    const limitButtonLayout = await limitButtons.evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button)
      const rect = button.getBoundingClientRect()
      return {
        width: rect.width,
        height: rect.height,
        radius: style.borderTopLeftRadius,
        whiteSpace: style.whiteSpace,
        flexShrink: style.flexShrink,
        scrollHeight: button.scrollHeight,
        clientHeight: button.clientHeight,
      }
    }))
    expect(new Set(limitButtonLayout.map((button) => button.radius)).size).toBe(1)
    expect(limitButtonLayout[0]?.radius).toBe('7px')
    for (const button of limitButtonLayout) {
      expect(button.whiteSpace).toBe('nowrap')
      expect(button.flexShrink).toBe('0')
      expect(button.width).toBeGreaterThan(32)
      expect(button.height).toBeLessThanOrEqual(28)
      expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight + 1)
    }
    await page.screenshot({ path: 'test-results/barn-settings-memory-limit.png', fullPage: true })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    const memoryEditor = page.getByRole('textbox', { name: 'MEMORY.md' })
    await memoryEditor.click()
    await memoryEditor.fill('# Memory\n\n- Use pnpm for Barn.')
    await page.getByRole('tab', { name: 'User portrait' }).click()

    await expect(page.getByRole('heading', { name: 'User portrait statistics' })).toBeVisible()
    const userEditor = page.getByRole('textbox', { name: 'USER.md' })
    await expect(userEditor).toHaveAttribute('placeholder', 'Write long-term memory in Markdown…')
    await userEditor.click()
    await userEditor.fill('# User\n\n- Prefers concise Chinese reports.')
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()

    await expect.poll(() => page.evaluate(async () => (await window.barn.memory.getDocument('memory')).content))
      .toContain('Use pnpm for Barn.')
    await expect.poll(() => page.evaluate(async () => (await window.barn.memory.getDocument('user')).content))
      .toContain('Prefers concise Chinese reports.')

    await memoryEditor.fill('# Memory\n\n- Use pnpm for Barn.\n- Run tests before release.')
    await page.getByRole('tab', { name: 'User portrait' }).click()
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.memory.listDocumentRevisions('memory')).length))
      .toBe(1)
    await page.getByText('Version history').click()
    await page.getByRole('button', { name: 'Restore' }).click()
    await expect.poll(() => page.evaluate(async () => (await window.barn.memory.getDocument('memory')).content))
      .not.toContain('Run tests before release.')

    await page.getByText('Memory runtime settings').click()
    const memorySwitch = page.getByRole('switch', { name: /Enable agent memory/ })
    await expect(memorySwitch).not.toBeChecked()
    await memorySwitch.check()
    await page.getByRole('button', { name: 'Save memory settings' }).click()
    await expect.poll(() => page.evaluate(async () => (await window.barn.memory.getSettings()).enabled)).toBe(true)

    const scroll = page.locator('.settings-page-scroll')
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(page.locator('.settings-scroll-edge.top')).toHaveClass(/visible/)

    await page.screenshot({ path: 'test-results/barn-settings-memory.png', fullPage: true })
  } finally {
    await app.close()
  }
})
