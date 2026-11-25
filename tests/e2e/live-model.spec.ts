import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'

test.skip(
  process.env.BARN_LIVE_MODEL_USER_DATA === undefined,
  'Set BARN_LIVE_MODEL_USER_DATA to a Barn user-data directory with a configured model.',
)
test.setTimeout(240_000)

test('uses the configured real model for direct replies, connector discovery, and a durable Task', async () => {
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

    await composer.fill('请用中文直接回答：2 + 2 等于几？只回答结果。')
    await composer.press('Enter')
    await waitForAssistantCount(page, initialMessages + 1)
    expect((await page.evaluate(() => window.barn.tasks.list()))).toHaveLength(0)

    const afterDirect = await assistantMessageCount(page)
    await composer.fill('列出当前配置的连接器。如果没有，直接告诉我“没有配置连接器”。不要创建任务。')
    await composer.press('Enter')
    await waitForAssistantCount(page, afterDirect + 1)
    expect((await page.evaluate(() => window.barn.tasks.list()))).toHaveLength(0)

    await composer.fill('请在当前工作区创建文件 live-router-smoke.txt，内容第一行为 hello。完成后告诉我文件路径。')
    await composer.press('Enter')
    await expect.poll(async () => page.evaluate(() => window.barn.tasks.list()), {
      timeout: 90_000,
      intervals: [500, 1_000, 2_000],
    }).toHaveLength(1)
    const task = (await page.evaluate(() => window.barn.tasks.list()))[0]!
    await waitForTaskStatus(page, task.id, 'completed', 120_000)
    expect(await readFile(join(userData, 'workspace', 'live-router-smoke.txt'), 'utf8')).toContain('hello')

    await page.evaluate((taskId) => window.barn.tasks.continueTask(taskId, '再追加一行 world，保留原内容。'), task.id)
    await expect.poll(async () => page.evaluate((taskId) => window.barn.tasks.get(taskId), task.id), {
      timeout: 120_000,
      intervals: [500, 1_000, 2_000],
    }).toMatchObject({ status: 'completed' })
    expect(await readFile(join(userData, 'workspace', 'live-router-smoke.txt'), 'utf8')).toContain('world')
    expect(await page.evaluate(() => window.barn.tasks.list())).toHaveLength(1)
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

async function waitForTaskStatus(
  page: Page,
  taskId: string,
  status: string,
  timeout: number,
): Promise<void> {
  await expect.poll(async () => page.evaluate((id) => window.barn.tasks.get(id).then((task) => task.status), taskId), {
    timeout,
    intervals: [500, 1_000, 2_000],
  }).toBe(status)
}
