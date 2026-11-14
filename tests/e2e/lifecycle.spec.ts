import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('stays resident when the window closes and reopens in Needs you', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-lifecycle-e2e-'))
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
    await expect(page.locator('.app-shell')).toBeVisible()

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible(), destroyed: window?.isDestroyed() }
    })).toEqual({ count: 1, visible: false, destroyed: false })

    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('runtime:show-tasks')
    })
    await expect(page.getByRole('heading', { name: 'Needs you', level: 1 })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-lifecycle.png', fullPage: true })
  } finally {
    await app.close()
  }
})
