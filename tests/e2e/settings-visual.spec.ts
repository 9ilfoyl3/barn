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
    await expect(page.getByRole('menuitem')).toHaveCount(2)
    await page.waitForTimeout(200)
    await page.screenshot({ path: 'test-results/barn-account-menu-zh.png', fullPage: true })
    await page.getByRole('menuitem', { name: '设置' }).click()
    await expect(page.locator('#account-panel')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByRole('button', { name: '通用', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: '通用', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: '记忆', exact: true })).toBeVisible()
    const settingsSearch = page.getByRole('searchbox', { name: '搜索设置' })
    await expect(settingsSearch).toHaveAttribute('type', 'search')
    await settingsSearch.focus()
    expect(await settingsSearch.evaluate((input) => getComputedStyle(input).outlineStyle)).toBe('none')
    expect(await settingsSearch.evaluate((input) => getComputedStyle(input).boxShadow)).toBe('none')
    expect(await settingsSearch.evaluate((input) => getComputedStyle(input.closest('[data-state]')!).borderTopWidth)).toBe('1px')
    expect(await page.locator('.settings-page-search').evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px')
    await expect(page.locator('.settings-page-search .barn-input-field')).toHaveCount(0)
    const sidebarSurface = await page.evaluate(() => {
      const pageSurface = document.querySelector('.settings-page')!
      const nav = document.querySelector('.settings-page-nav') as HTMLElement
      const panel = document.querySelector('.settings-page-nav-panel') as HTMLElement
      const content = document.querySelector('.settings-page-content') as HTMLElement
      const header = document.querySelector('.settings-page-nav-header') as HTMLElement
      const search = document.querySelector('.settings-page-search') as HTMLElement
      const navStyle = getComputedStyle(nav)
      const panelStyle = getComputedStyle(panel)
      const contentStyle = getComputedStyle(content)
      return {
        heights: [pageSurface.getBoundingClientRect().height, nav.getBoundingClientRect().height, panel.getBoundingClientRect().height],
        backgrounds: [navStyle.backgroundColor, panelStyle.backgroundColor, contentStyle.backgroundColor],
        headerGap: search.getBoundingClientRect().top - header.getBoundingClientRect().top,
      }
    })
    expect(Math.max(...sidebarSurface.heights) - Math.min(...sidebarSurface.heights)).toBeLessThanOrEqual(1)
    expect(new Set(sidebarSurface.backgrounds).size).toBe(1)
    expect(sidebarSurface.headerGap).toBeGreaterThanOrEqual(10)
    expect(sidebarSurface.headerGap).toBeLessThanOrEqual(16)
    await page.getByRole('heading', { name: '通用', level: 1 }).click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/barn-settings-general-zh.png', fullPage: true })
    await page.getByRole('button', { name: '语言' }).click()
    await expect(page.getByRole('listbox')).toBeVisible()
    await expect(page.getByRole('option', { name: '系统默认' })).toBeVisible()
    const triggerRadii = await page.getByRole('button', { name: '语言' }).evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
    })
    expect(new Set(triggerRadii).size).toBe(1)
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/barn-settings-select-open-zh.png', fullPage: true })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '模型', exact: true }).click()
    await expect(page.getByRole('heading', { name: '模型与 API', level: 1 })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-settings-models-zh.png', fullPage: true })

    await page.getByRole('button', { name: '诊断', exact: true }).click()
    await expect(page.getByRole('heading', { name: '诊断', level: 1 })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-settings-diagnostics-zh.png', fullPage: true })

    await page.getByRole('button', { name: '记忆', exact: true }).click()
    await page.getByRole('tab', { name: '用户画像' }).click()
    await page.getByRole('textbox', { name: 'USER.md' }).click()
    await expect(page.getByRole('textbox', { name: 'USER.md' })).toBeFocused()
    await expect(page.locator('.memory-document-editor-heading')).toHaveCount(0)
    expect(await page.locator('.memory-document-editor').evaluate((element) => getComputedStyle(element).boxShadow)).not.toContain('0px 0px 0px 3px')
    expect(await page.getByRole('textbox', { name: 'USER.md' }).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
    await page.screenshot({ path: 'test-results/barn-settings-memory-focus-zh.png', fullPage: true })

    await page.screenshot({ path: 'test-results/barn-settings-memory-zh.png', fullPage: true })
  } finally {
    await app.close()
  }
})
