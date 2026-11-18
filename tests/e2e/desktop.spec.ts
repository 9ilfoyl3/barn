import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('opens the personal secretary workspace and model configuration', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-secretary-e2e-'))
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
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.locator('.app-shell').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })

    await expect(window.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible()
    await expect(window.getByRole('heading', { name: 'Routines' })).toBeVisible()
    await expect(window.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(window.locator('.secretary-presence')).toBeVisible()
    await expect(window.getByRole('button', { name: /New session/i })).toHaveCount(0)
    await expect(window.locator('.session-row')).toHaveCount(0)
    await expect(window.locator('.today-panel')).toBeVisible()
    await expect(window.locator('.task-rail')).toBeVisible()

    await window.getByRole('button', { name: /Search Barn/ }).click()
    const palette = window.getByRole('dialog', { name: 'Search Barn' })
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('searchbox')).toBeFocused()
    await palette.getByRole('button', { name: 'Close' }).click()

    await window.locator('.account-row').click()
    await expect(window.getByRole('menuitem', { name: /Models/i })).toBeVisible()
    await window.getByRole('menuitem', { name: /Models/i }).click()
    await expect(window.getByRole('dialog', { name: 'Model settings' })).toBeVisible()
    await expect(window.getByPlaceholder('Search providers')).toBeVisible()
    await window.getByRole('button', { name: 'Close settings' }).click()

    await expect(window.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/)
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
    await window.screenshot({ path: 'test-results/barn-personal-secretary.png', fullPage: true })
  } finally {
    await app.close()
  }
})

test('does not persist a Session before the first message and exposes no Session management', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-empty-session-e2e-'))
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
    await expect(page.getByRole('button', { name: /New session/i })).toHaveCount(0)
    await expect(page.locator('.session-row')).toHaveCount(0)
    await expect(page.locator('.secretary-presence')).toBeVisible()
    expect(await page.evaluate(() => window.barn.sessions.list())).toHaveLength(0)

    await page.locator('.account-row').click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await expect(page.getByText('Archived chats', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Local sources' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Diagnostics and memory' })).toBeVisible()
  } finally {
    await app.close()
  }
})


test('applies and persists a Simplified Chinese language preference', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-language-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const launch = (language: 'en' | 'zh-CN') => electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: language,
    },
  })

  const app = await launch('en')
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => window.localStorage.setItem('barn.language', 'zh-CN'))
    await page.reload()

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.getByRole('heading', { name: '今天需要处理什么？' })).toBeVisible()
    await expect(page.getByLabel('给 Barn 发消息')).toBeVisible()
    await expect(page.getByRole('button', { name: '主页' })).toBeVisible()

    await page.locator('.account-row').click()
    await page.getByRole('button', { name: '界面语言' }).click()
    const submenu = page.locator('.language-submenu')
    await expect(submenu).toBeVisible()
    const languageSubmenuMotion = await submenu.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        className: element.className,
        animationName: style.animationName,
        animationDuration: Number.parseFloat(style.animationDuration),
      }
    })
    expect(languageSubmenuMotion.className).toContain('secondary-menu')
    expect(languageSubmenuMotion.animationName).toContain('secondary-menu-enter')
    expect(languageSubmenuMotion.animationDuration).toBeGreaterThan(0)
    const submenuBounds = await submenu.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight,
      }
    })
    expect(submenuBounds.left).toBeGreaterThanOrEqual(11.5)
    expect(submenuBounds.top).toBeGreaterThanOrEqual(11.5)
    expect(submenuBounds.right).toBeLessThanOrEqual(submenuBounds.viewportWidth - 11.5)
    expect(submenuBounds.bottom).toBeLessThanOrEqual(submenuBounds.viewportHeight - 11.5)
    await page.screenshot({ path: 'test-results/barn-desktop-zh-CN.png', fullPage: true })
  } finally {
    await app.close()
  }

  const restoredApp = await launch('zh-CN')
  try {
    const page = await restoredApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.getByRole('heading', { name: '今天需要处理什么？' })).toBeVisible()
  } finally {
    await restoredApp.close()
  }
})
