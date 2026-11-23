import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('manages local skills from the Plugins page and exposes them to the Agent bridge', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-skills-e2e-'))
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
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await page.locator('.app-rail-button', { hasText: 'Plugins' }).click()
    await page.getByRole('tab', { name: 'Skills' }).click()

    const skills = page.locator('.skills-panel')
    await expect(skills.getByText('Meeting notes to actions')).toBeVisible()
    await expect(skills.getByText('System', { exact: true }).first()).toBeVisible()

    const search = page.getByRole('searchbox', { name: 'Search skills' })
    await search.focus()
    await expect.poll(() => search.evaluate((input) => getComputedStyle(input).outlineStyle)).toBe('none')
    await expect.poll(() => search.evaluate((input) => getComputedStyle(input.parentElement!).boxShadow)).not.toBe('none')
    await page.screenshot({ path: 'test-results/barn-skills-search-focus.png', fullPage: true })

    await skills.getByRole('button', { name: 'New skill' }).click()
    const create = page.getByRole('dialog', { name: 'Create skill' })
    await page.screenshot({ path: 'test-results/barn-skill-editor.png', fullPage: true })
    await create.getByLabel('Skill name').fill('Weekly status')
    await create.getByLabel('Description').fill('Turn a week of work into a concise status update.')
    await create.getByLabel('Instructions').fill('# Weekly status\n\n1. Summarize outcomes.\n2. List blockers.\n3. Name next steps.')
    await create.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Skill created.' })).toBeVisible()

    const detail = page.getByRole('dialog', { name: 'Weekly status' })
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('Summarize outcomes.')
    await page.screenshot({ path: 'test-results/barn-skill-detail.png', fullPage: true })
    await expect.poll(async () => page.evaluate(async () => (await window.barn.skills.list()).some((skill) => (
      skill.name === 'Weekly status' && skill.source === 'custom' && skill.enabled
    )))).toBe(true)

    await detail.getByRole('button', { name: 'Edit' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit skill' })
    await edit.getByLabel('Description').fill('Create a concise weekly status update.')
    await edit.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Weekly status' })).toContainText('Create a concise weekly status update.')
    await page.getByRole('dialog', { name: 'Weekly status' }).getByRole('button', { name: 'Close' }).click()

    const row = skills.locator('.skill-row', { hasText: 'Weekly status' })
    await row.locator('.skill-switch').click()
    await expect.poll(async () => page.evaluate(async () => {
      const skill = (await window.barn.skills.list()).find((entry) => entry.name === 'Weekly status')
      return skill?.enabled
    })).toBe(false)
    await row.locator('.skill-switch').click()

    await skills.locator('input[type="file"]').setInputFiles({
      name: 'launch-brief.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nname: Launch brief\ndescription: Prepare a launch decision brief.\n---\n\n# Launch brief\n\nList risks and open questions.'),
    })
    await expect(page.getByRole('dialog', { name: 'Launch brief' })).toContainText('List risks and open questions.')
    await page.getByRole('dialog', { name: 'Launch brief' }).getByRole('button', { name: 'Close' }).click()
    await expect(skills.getByText('Launch brief')).toBeVisible()

    page.once('dialog', (confirmation) => void confirmation.accept())
    await skills.locator('.skill-row', { hasText: 'Weekly status' }).getByRole('button', { name: 'Open Weekly status skill' }).click()
    await page.getByRole('dialog', { name: 'Weekly status' }).getByRole('button', { name: 'Delete' }).click()
    await expect(skills.getByText('Weekly status')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/barn-skills.png', fullPage: true })
  } finally {
    await app.close()
  }
})
