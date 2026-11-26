import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('model settings follows overview, provider, and connection steps', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-model-wizard-'))
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
    await page.getByRole('menuitem', { name: '设置' }).click()
    await page.getByRole('button', { name: '模型', exact: true }).click()

    await expect(page.getByRole('heading', { name: '模型与 API', level: 1 })).toBeVisible()
    await expect(page.getByText('已配置模型')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-models-overview-zh.png', fullPage: true })

    await page.getByRole('button', { name: '添加提供商' }).click()
    await expect(page.getByRole('heading', { name: '选择供应商' })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-models-providers-zh.png', fullPage: true })

    await page.getByRole('button', { name: 'OpenAI', exact: true }).click()
    await expect(page.getByRole('heading', { name: '连接 OpenAI' })).toBeVisible()
    await expect(page.getByLabel('API 密钥')).toBeVisible()
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled()
    await page.screenshot({ path: 'test-results/barn-models-connect-zh.png', fullPage: true })

    await page.getByLabel('API 密钥').fill('sk-test-only')
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled()
  } finally {
    await app.close()
  }
})
