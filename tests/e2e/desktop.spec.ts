import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('opens the Desktop workspace and model configuration', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-e2e-'))
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

    await expect(window.getByRole('heading', { name: 'What needs attention?' })).toBeVisible()
    await expect(window.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/)
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
    const accountTrigger = window.locator('.account-row')
    const accountPopover = window.locator('.account-popover')
    await accountTrigger.click()
    await expect(window.getByRole('menuitem', { name: /Models/i })).toBeVisible()
    await expect(accountPopover).toHaveClass(/open/)
    const accountMotion = await accountPopover.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        property: style.transitionProperty,
        duration: Number.parseFloat(style.transitionDuration),
      }
    })
    expect(accountMotion.property).toContain('opacity')
    expect(accountMotion.property).toContain('transform')
    expect(accountMotion.duration).toBeGreaterThan(0)
    await window.screenshot({ path: 'test-results/barn-user-menu.png', fullPage: true })
    await window.getByRole('heading', { name: 'What needs attention?' }).click()
    await expect(accountPopover).toBeHidden()
    await expect(accountTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByText(/Shell sandbox:/)).toBeVisible()
    if (process.platform === 'darwin') {
      const titlebarLayout = await window.evaluate(() => {
        const sidebarTitlebar = document.querySelector('.sidebar-titlebar')!.getBoundingClientRect()
        const workspaceHeader = document.querySelector('.workspace-header')!.getBoundingClientRect()
        const sidebarToggle = document.querySelector('.sidebar-toggle-sidebar')!.getBoundingClientRect()
        return {
          sidebarHeight: sidebarTitlebar.height,
          workspaceHeight: workspaceHeader.height,
          sidebarCenter: sidebarTitlebar.top + sidebarTitlebar.height / 2,
          toggleCenter: sidebarToggle.top + sidebarToggle.height / 2,
        }
      })
      expect(titlebarLayout.sidebarHeight).toBe(titlebarLayout.workspaceHeight)
      expect(Math.abs(titlebarLayout.toggleCenter - titlebarLayout.sidebarCenter)).toBeLessThanOrEqual(0.5)
    }

    const searchTrigger = window.getByRole('button', { name: 'Search sessions' })
    await searchTrigger.click()
    const sessionSearch = window.locator('.session-search')
    const sessionSearchInput = window.getByRole('searchbox', { name: 'Filter sessions' })
    await expect(sessionSearchInput).toBeFocused()
    await sessionSearch.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    await expect.poll(async () => (await sessionSearch.boundingBox())?.width ?? 0).toBeGreaterThan(200)

    const searchLayout = await window.evaluate(() => {
      const logo = document.querySelector('.brand-lockup')!.getBoundingClientRect()
      const field = document.querySelector('.session-search')!.getBoundingClientRect()
      const trigger = document.querySelector('.session-search-trigger')!.getBoundingClientRect()
      const logoHit = document.elementFromPoint(logo.x + logo.width / 2, logo.y + logo.height / 2)
      const transition = getComputedStyle(document.querySelector('.session-search')!)
      return {
        logoLeft: logo.left,
        logoBottom: logo.bottom,
        fieldLeft: field.left,
        fieldRight: field.right,
        fieldTop: field.top,
        triggerRight: trigger.right,
        fieldCoversLogo: logoHit?.closest('.session-search') !== null,
        transitionProperty: transition.transitionProperty,
        transitionDuration: Number.parseFloat(transition.transitionDuration),
      }
    })
    expect(searchLayout.fieldLeft).toBeLessThanOrEqual(searchLayout.logoLeft + 0.5)
    expect(Math.abs(searchLayout.fieldRight - searchLayout.triggerRight)).toBeLessThanOrEqual(0.5)
    expect(searchLayout.fieldTop).toBeLessThan(searchLayout.logoBottom)
    expect(searchLayout.fieldCoversLogo).toBe(true)
    expect(searchLayout.transitionProperty).toContain('width')
    expect(searchLayout.transitionDuration).toBeGreaterThan(0)
    await window.screenshot({ path: 'test-results/barn-session-search.png', fullPage: true })

    await window.getByRole('button', { name: 'Close search' }).click()
    await expect(window.getByRole('button', { name: 'Search sessions' })).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await sessionSearch.boundingBox())?.width ?? 0).toBeLessThan(1)

    const sidebarTransition = await window.locator('.app-shell').evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(Number.parseFloat(sidebarTransition)).toBeGreaterThan(0)
    const expandedToggleBox = await window.getByRole('button', { name: 'Hide sidebar' }).boundingBox()

    await window.getByRole('button', { name: 'Hide sidebar' }).click()
    await expect(window.locator('.sidebar')).toBeHidden()
    const collapsedToggle = window.getByRole('button', { name: 'Show sidebar' })
    await expect(collapsedToggle).toBeVisible()
    await expect(window.locator('.workspace-header .sidebar-toggle')).toHaveCount(1)
    const collapsedToggleBox = await collapsedToggle.boundingBox()
    expect(expandedToggleBox?.x).toBe(collapsedToggleBox?.x)
    expect(Math.abs((expandedToggleBox?.y ?? 0) - (collapsedToggleBox?.y ?? 0))).toBeLessThanOrEqual(0.5)
    if (process.platform === 'darwin') {
      expect(collapsedToggleBox?.x).toBe(82)
      expect(collapsedToggleBox?.y).toBeCloseTo(13.5)
    }
    if (collapsedToggleBox !== null) {
      const hitTarget = await window.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        return element?.closest('.sidebar-toggle') !== null
      }, {
        x: collapsedToggleBox.x + collapsedToggleBox.width / 2,
        y: collapsedToggleBox.y + collapsedToggleBox.height / 2,
      })
      expect(hitTarget).toBe(true)
    }
    const collapsedLayout = await window.evaluate(() => ({
      viewportWidth: globalThis.innerWidth,
      workspaceWidth: document.querySelector('.workspace')?.getBoundingClientRect().width,
      headerPaddingLeft: Number.parseFloat(getComputedStyle(document.querySelector('.workspace-header')!).paddingLeft),
    }))
    expect(collapsedLayout.workspaceWidth).toBe(collapsedLayout.viewportWidth)
    if (process.platform === 'darwin') {
      expect(collapsedLayout.headerPaddingLeft).toBeGreaterThanOrEqual(80)
    }
    await window.screenshot({
      path: 'test-results/barn-desktop-sidebar-collapsed.png',
      fullPage: true,
    })
    if (collapsedToggleBox !== null) {
      await window.mouse.click(
        collapsedToggleBox.x + collapsedToggleBox.width / 2,
        collapsedToggleBox.y + collapsedToggleBox.height / 2,
      )
    }
    await expect(window.locator('.sidebar')).toBeVisible()

    await window.getByRole('button', { name: /New session/i }).click()
    await expect(window.locator('.session-row')).toHaveCount(0)
    await expect(window.getByRole('heading', { name: 'What needs attention?' })).toBeVisible()

    await window.screenshot({
      path: 'test-results/barn-desktop.png',
      fullPage: true,
    })

    await window.locator('.account-row').click()
    await window.getByRole('menuitem', { name: /Models/i }).click()
    await expect(window.getByRole('dialog', { name: 'Model settings' })).toBeVisible()
    await expect(window.getByPlaceholder('Search providers')).toBeVisible()

    await window.getByPlaceholder('Search providers').fill('deepseek')
    await window.locator('.provider-row', { hasText: 'DeepSeek' }).click()
    await window.getByLabel('API key').fill('test-key-not-real')
    await window.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(window.getByText('Configured', { exact: true })).toBeVisible()

    const firstModel = window.locator('.model-row').first()
    await firstModel.click()
    await expect(window.locator('.model-row.active')).toHaveCount(1)

    await window.screenshot({
      path: 'test-results/barn-model-settings.png',
      fullPage: true,
    })
  } finally {
    await app.close()
  }
})

test('does not persist a new session until the first message is sent', async () => {
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
    const newSession = page.getByRole('button', { name: /New session/i })

    await newSession.click()
    await newSession.click()
    await expect(page.locator('.session-row')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'What needs attention?' })).toBeVisible()

    const storedSessions = await page.evaluate(() => window.barn.sessions.list())
    expect(storedSessions).toHaveLength(0)
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
    await expect(page.getByRole('button', { name: '隐藏侧边栏' })).toBeVisible()

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
