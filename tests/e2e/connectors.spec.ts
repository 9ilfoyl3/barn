import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('configures and removes an email connector from the plugins page', async () => {
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
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })

    await page.locator('.app-rail-button', { hasText: 'Plugins' }).click()
    const plugins = page.locator('.plugins-page')
    await expect(plugins).toBeVisible()
    await expect.poll(() => plugins.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe('rgb(255, 255, 255)')
    await expect(plugins.getByRole('tab', { name: 'Plugins' })).toBeVisible()
    await expect(plugins.getByText('MCP servers')).toBeVisible()
    await expect(plugins.locator('[data-plugin-kind="email"]')).toContainText('Email')
    await expect(plugins.locator('[data-plugin-kind="email"] [data-brand-icon="email"] svg')).toBeVisible()
    await expect(plugins.locator('[data-plugin-kind="dingtalk"] [data-brand-icon="dingtalk"] svg'))
      .toHaveAttribute('viewBox', '0 0 1024 1024')
    await page.screenshot({ path: 'test-results/barn-plugins-catalog.png', fullPage: true })

    await plugins.getByRole('tab', { name: 'Skills' }).click()
    await expect(plugins.getByText('Meeting notes to actions')).toBeVisible()
    await plugins.getByRole('tab', { name: 'Plugins' }).click()
    await plugins.getByRole('searchbox', { name: 'Search plugins' }).fill('DingTalk')
    await expect(plugins.locator('[data-plugin-kind="email"]')).toHaveCount(0)
    await expect(plugins.locator('[data-plugin-kind="dingtalk"]')).toContainText('DingTalk')
    await plugins.getByRole('button', { name: 'Clear search' }).click()

    await plugins.locator('[data-plugin-kind="email"]').getByRole('button', { name: 'Add Email' }).click()
    await plugins.getByRole('textbox', { name: 'Connection name' }).fill('Work mail')
    await plugins.getByRole('textbox', { name: 'Email address' }).fill('person@example.com')
    await plugins.getByRole('textbox', { name: 'IMAP server' }).fill('imap.example.com')
    await plugins.getByRole('spinbutton', { name: 'IMAP port' }).fill('993')
    await plugins.getByRole('textbox', { name: 'SMTP server' }).fill('smtp.example.com')
    await plugins.getByRole('spinbutton', { name: 'SMTP port' }).fill('465')
    await plugins.getByRole('textbox', { name: 'Username' }).fill('person@example.com')
    await plugins.getByLabel('Password or app password').fill('app-password')
    await plugins.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(plugins.locator('.plugin-instance-row')).toContainText('Work mail')
    await expect(plugins.locator('.plugin-instance-row').getByRole('img', { name: 'Ready' })).toBeVisible()
    await plugins.getByRole('button', { name: 'Back to plugins' }).click()
    const emailPlugin = plugins.locator('[data-plugin-kind="email"]')
    await expect(emailPlugin).toContainText('1 connection')
    await emailPlugin.getByRole('button', { name: 'Manage Email' }).click()
    await expect(plugins.locator('.plugin-instance-row')).toContainText('Work mail')
    await expect.poll(async () => page.evaluate(async () => {
      const instances = await window.barn.connectors.list()
      return instances.map((instance) => ({
        name: instance.name,
        configured: instance.configured,
        status: instance.status,
      }))
    })).toEqual([{ name: 'Work mail', configured: true, status: 'ready' }])

    await page.screenshot({ path: 'test-results/barn-plugins-page.png', fullPage: true })
    page.once('dialog', (confirmation) => void confirmation.accept())
    await plugins.getByRole('button', { name: 'Remove connector' }).click()
    await expect(plugins.getByText('No connections yet')).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectors.list()).length)).toBe(0)
  } finally {
    await app.close()
  }
})


test('configures and removes a GitHub token connector', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-github-e2e-'))
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
    const plugins = page.locator('.plugins-page')
    const github = plugins.locator('[data-plugin-kind="github"]')
    await expect(github).toContainText('GitHub')
    await expect(github.locator('[data-brand-icon="github"] svg')).toHaveAttribute('viewBox', '0 0 24 24')
    await github.getByRole('button', { name: 'Add GitHub' }).click()

    const help = plugins.getByRole('link', { name: 'Create a GitHub personal access token' })
    await expect(help).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens/new')
    await plugins.getByRole('textbox', { name: 'Connection name' }).fill('GitHub work')
    await plugins.getByLabel('Personal access token').fill('github_pat_test-token')
    await page.screenshot({ path: 'test-results/barn-github-form.png', fullPage: true })
    await plugins.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(plugins.locator('.plugin-instance-row')).toContainText('GitHub work')
    await expect(plugins.locator('.plugin-instance-row').getByRole('img', { name: 'Ready' })).toBeVisible()
    await expect(plugins.getByText('Search repositories', { exact: true })).toBeVisible()
    await expect(plugins.getByText('List my repositories', { exact: true })).toBeVisible()
    await expect(plugins.getByText('Read a repository', { exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => {
      const instances = await window.barn.connectors.list()
      return instances.map((instance) => ({
        kind: instance.kind,
        name: instance.name,
        configured: instance.configured,
        status: instance.status,
        capabilities: instance.capabilities.map((capability) => capability.id),
      }))
    })).toEqual([{
      kind: 'github',
      name: 'GitHub work',
      configured: true,
      status: 'ready',
      capabilities: [
        'github.searchRepositories',
        'github.listRepositories',
        'github.getRepository',
        'github.searchIssues',
        'github.listIssues',
        'github.getIssue',
        'github.listPullRequests',
        'github.getPullRequest',
        'github.createIssue',
        'github.comment',
      ],
    }])
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/barn-github.png', fullPage: true })

    await plugins.getByRole('button', { name: 'Back to plugins' }).click()
    const githubStatus = plugins.locator('[data-plugin-kind="github"] [data-connector-status="ready"]')
    await expect(githubStatus).toHaveAttribute('aria-label', 'Ready')
    await expect(githubStatus).toHaveText('')
    await expect(githubStatus.locator('[data-status-icon="ready"]')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-plugin-status.png', fullPage: true })
    await plugins.locator('[data-plugin-kind="github"]').getByRole('button', { name: 'Manage GitHub' }).click()

    page.once('dialog', (confirmation) => void confirmation.accept())
    await plugins.getByRole('button', { name: 'Remove connector' }).click()
    await expect(plugins.getByText('No connections yet')).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.connectors.list()).length)).toBe(0)
  } finally {
    await app.close()
  }
})


test('shows a simple DingTalk install and sign-in flow', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-dingtalk-e2e-'))
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
    const plugins = page.locator('.plugins-page')
    await expect(plugins).toBeVisible()
    await plugins.locator('[data-plugin-kind="dingtalk"]').getByRole('button', { name: 'Add DingTalk' }).click()
    const setup = plugins.locator('.dingtalk-setup')
    await expect(setup).toContainText('Connect DingTalk')
    await expect(setup).toContainText('small local connector')
    await expect(setup.getByRole('button', { name: 'Install', exact: true })).toBeVisible()
    await expect(setup.getByText(/\b(dws|cli)\b/iu)).toHaveCount(0)
    await expect(plugins.getByText('Read messages', { exact: true })).toBeVisible()
    await expect(plugins.getByText('Direct send', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-dingtalk.png', fullPage: true })
    await setup.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(setup).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('shows and resolves a connector approval in the task center', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-connector-approval-e2e-'))
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
    await page.evaluate(async () => {
      const connector = await window.barn.connectors.create({
        kind: 'github',
        name: 'Approval account',
        config: {},
      })
      await window.barn.connectors.saveCredentials({
        connectorId: connector.id,
        values: {
          token: 'github_pat_test-token',
        },
      })
      const result = await window.barn.connectors.call({
        connectorId: connector.id,
        capability: 'github.comment',
        arguments: { owner: 'acme', repo: 'widgets', number: 7, body: 'Release is ready' },
      })
      if (result.kind !== 'action' || result.status !== 'pending_approval') {
        throw new Error(`Expected a pending connector action, received ${JSON.stringify(result)}`)
      }
    })

    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Connector actions' })).toBeVisible()
    const connectorGroup = page.locator('.connector-action-group')
    await expect(connectorGroup).toContainText('Comment on an issue or pull request')
    await expect(connectorGroup).toContainText('Approval account')
    await expect(connectorGroup).toContainText('Waiting for your decision')
    await page.screenshot({ path: 'test-results/barn-connector-approval.png', fullPage: true })

    await connectorGroup.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Connector actions' })).toBeVisible()
    await expect(connectorGroup).toContainText('Dismissed', { timeout: 6_000 })
  } finally {
    await app.close()
  }
})
