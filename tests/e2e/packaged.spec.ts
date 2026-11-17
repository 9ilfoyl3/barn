import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath = process.env.BARN_PACKAGED_EXECUTABLE

test.skip(executablePath === undefined, 'BARN_PACKAGED_EXECUTABLE is not configured')

test('packaged Desktop starts and loads the workspace', async () => {
  if (executablePath === undefined) throw new Error('BARN_PACKAGED_EXECUTABLE is not configured')
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-packaged-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    executablePath,
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
    await expect(window.locator('.secretary-presence')).toBeVisible()
  } finally {
    await app.close()
  }
})
