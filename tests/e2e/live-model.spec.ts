import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'

test.skip(
  process.env.BARN_LIVE_MODEL_USER_DATA === undefined,
  'Set BARN_LIVE_MODEL_USER_DATA to a Barn user-data directory with a configured model.',
)
test.setTimeout(240_000)

test('uses the configured real model for direct replies, connector discovery, and ordinary file work', async () => {
  const source = process.env.BARN_LIVE_MODEL_USER_DATA!
  const userData = await mkdtemp(join(tmpdir(), 'barn-live-model-e2e-'))
  await cp(join(source, 'models'), join(userData, 'models'), { recursive: true })
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const executablePath = process.env.BARN_LIVE_MODEL_APP
  const app = await electron.launch({
    ...(executablePath === undefined ? { args: ['.'] } : { executablePath }),
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
    const snapshot = await page.evaluate(() => window.barn.models.getSnapshot())
    expect(snapshot.defaultModel).toBeDefined()

    const composer = page.getByLabel('给 Barn 发消息')
    const initialMessages = await assistantMessageCount(page)
    const initialTasks = await page.evaluate(() => window.barn.tasks.list())

    await composer.fill('请用中文直接回答：2 + 2 等于几？只回答结果。')
    await composer.press('Enter')
    await waitForAssistantCount(page, initialMessages + 1)
    expect(await page.evaluate(() => window.barn.tasks.list())).toHaveLength(initialTasks.length)

    const afterDirect = await assistantMessageCount(page)
    await composer.fill('列出当前配置的连接器。如果没有，直接告诉我“没有配置连接器”。不要创建任务。')
    await composer.press('Enter')
    await waitForAssistantCount(page, afterDirect + 1)
    expect(await page.evaluate(() => window.barn.tasks.list())).toHaveLength(initialTasks.length)

    const afterConnectorTasks = await page.evaluate(() => window.barn.tasks.list())
    const afterFile = await assistantMessageCount(page)
    await composer.fill('请在当前工作区创建文件 live-router-smoke.txt，内容第一行为 hello。完成后告诉我文件路径。')
    await composer.press('Enter')
    await waitForAssistantCount(page, afterFile + 1)
    expect(await page.evaluate(() => window.barn.tasks.list())).toHaveLength(afterConnectorTasks.length)
    expect(await readFile(join(userData, 'workspace', 'live-router-smoke.txt'), 'utf8')).toContain('hello')

    const afterWrite = await assistantMessageCount(page)
    await composer.fill('把 live-router-smoke.txt 的内容改成两行：hello 和 world。完成后确认。')
    await composer.press('Enter')
    await waitForAssistantCount(page, afterWrite + 1)
    expect(await page.evaluate(() => window.barn.tasks.list())).toHaveLength(afterConnectorTasks.length)
    const updated = await readFile(join(userData, 'workspace', 'live-router-smoke.txt'), 'utf8')
    expect(updated).toContain('hello')
    expect(updated).toContain('world')
  } finally {
    await app.close()
  }
})

async function assistantMessageCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const snapshot = await window.barn.threads.getSnapshot()
    return snapshot.messages.filter((message) => message.role === 'assistant').length
  })
}

async function waitForAssistantCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect.poll(() => assistantMessageCount(page), {
    timeout: 90_000,
    intervals: [500, 1_000, 2_000],
  }).toBeGreaterThanOrEqual(count)
}
