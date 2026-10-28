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
    },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    await expect(window.getByRole('heading', { name: 'What needs attention?' })).toBeVisible()
    await expect(window.getByRole('button', { name: /Models/i })).toBeVisible()
    await expect(window.getByText(/Shell sandbox:/)).toBeVisible()
    if (process.platform === 'darwin') {
      const paddingTop = await window.locator('.sidebar-content').evaluate((element) => getComputedStyle(element).paddingTop)
      expect(Number.parseFloat(paddingTop)).toBeGreaterThanOrEqual(40)
    }

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
    expect(expandedToggleBox?.y).toBe(collapsedToggleBox?.y)
    if (process.platform === 'darwin') {
      expect(collapsedToggleBox?.x).toBe(82)
      expect(collapsedToggleBox?.y).toBe(3)
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

    await window.getByRole('button', { name: /Models/i }).click()
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
