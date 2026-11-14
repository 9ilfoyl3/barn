import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('configures a watched folder and turns a file change into a suggestion', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-source-e2e-'))
  const watched = join(userData, 'watched')
  const file = join(watched, 'notes.txt')
  await mkdir(watched, { recursive: true })
  await writeFile(file, 'first version')
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
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, watched)

    await page.locator('.account-row').click()
    await page.getByRole('menuitem', { name: 'Local sources' }).click()
    await expect(page.getByRole('dialog', { name: 'Local sources' })).toBeVisible()
    await page.getByRole('button', { name: 'Watch a folder' }).click()
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await expect(page.getByRole('textbox', { name: 'Source name' })).toHaveValue('watched')
    await page.getByRole('button', { name: 'Add source' }).click()
    await expect(page.locator('.source-settings-row')).toContainText('watched')

    await page.waitForTimeout(500)
    await writeFile(file, 'second version with a change')
    await page.getByRole('button', { name: 'Check now' }).click()

    await expect.poll(async () => page.evaluate(async () => {
      const tasks = await window.barn.tasks.list()
      return tasks.filter((task) => task.status === 'proposed').length
    })).toBe(1)
    await page.getByRole('button', { name: 'Close local sources' }).click()
    await expect(page.locator('.task-nav-count')).toHaveText('1')
    await page.locator('.task-nav-button').click()
    await expect(page.getByText('Review changed file: notes.txt')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-local-sources.png', fullPage: true })
  } finally {
    await app.close()
  }
})
