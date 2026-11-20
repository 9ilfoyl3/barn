import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('configures and removes an email connector from settings', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-connectors-e2e-'))
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
    await page.getByRole('menuitem', { name: 'Connectors' }).click()
    const dialog = page.getByRole('dialog', { name: 'Connectors' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('No connectors yet')).toBeVisible()

    await dialog.locator('.connector-definition-card').first().click()
    await dialog.getByRole('textbox', { name: 'Connection name' }).fill('Work mail')
    await dialog.getByRole('textbox', { name: 'Email address' }).fill('person@example.com')
    await dialog.getByRole('textbox', { name: 'IMAP server' }).fill('imap.example.com')
    await dialog.getByRole('spinbutton', { name: 'IMAP port' }).fill('993')
    await dialog.getByRole('textbox', { name: 'SMTP server' }).fill('smtp.example.com')
    await dialog.getByRole('spinbutton', { name: 'SMTP port' }).fill('465')
    await dialog.getByRole('textbox', { name: 'Username' }).fill('person@example.com')
    await dialog.getByLabel('Password or app password').fill('app-password')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(dialog.locator('.connector-row')).toContainText('Work mail')
    await expect(dialog.locator('.connector-row')).toContainText('Ready')
    await expect.poll(async () => page.evaluate(async () => {
      const instances = await window.barn.connectors.list()
      return instances.map((instance) => ({
        name: instance.name,
        configured: instance.configured,
        status: instance.status,
      }))
    })).toEqual([{ name: 'Work mail', configured: true, status: 'ready' }])

    await page.screenshot({ path: 'test-results/barn-connectors.png', fullPage: true })
    page.once('dialog', (confirmation) => void confirmation.accept())
    await dialog.getByRole('button', { name: 'Remove connector' }).click()
    await expect(dialog.getByText('No connectors yet')).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectors.list()).length)).toBe(0)
  } finally {
    await app.close()
  }
})
