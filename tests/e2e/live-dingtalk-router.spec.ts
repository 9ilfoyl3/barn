import { chromium, expect, test, type Page } from '@playwright/test'

test.skip(
  process.env.BARN_LIVE_CDP_URL === undefined,
  'Set BARN_LIVE_CDP_URL to a running Barn app launched with --remote-debugging-port.',
)
test.setTimeout(360_000)

test('answers a multi-step DingTalk request in the Router without creating a Task', async () => {
  const browser = await chromium.connectOverCDP(process.env.BARN_LIVE_CDP_URL!)
  try {
    const page = browser.contexts()[0]?.pages()[0]
    if (page === undefined) throw new Error('The running Barn app has no page')
    await page.waitForLoadState('domcontentloaded')
    const snapshot = await page.evaluate(() => window.barn.models.getSnapshot())
    expect(snapshot.defaultModel).toBeDefined()

    const connector = await page.evaluate(async () => {
      const existing = (await window.barn.connectors.list()).find((entry) => entry.kind === 'dingtalk')
      return existing ?? window.barn.connectors.create({
        kind: 'dingtalk',
        name: 'DingTalk',
        config: {},
      })
    })
    const health = await page.evaluate((id) => window.barn.connectors.test(id), connector.id)
    expect(health).toMatchObject({ ok: true })

    const composer = page.getByLabel('给 Barn 发消息')
    const beforeMessages = await assistantMessageCount(page)
    const beforeTasks = await page.evaluate(() => window.barn.tasks.list())

    await composer.fill('帮我看看我跟陈诗茹的钉钉最近聊了什么')
    await composer.press('Enter')
    await waitForAssistantCount(page, beforeMessages + 1)

    expect(await page.evaluate(() => window.barn.tasks.list())).toHaveLength(beforeTasks.length)
    const reply = await lastAssistantText(page)
    expect(reply.length).toBeGreaterThan(0)
    expect(reply).not.toMatch(/timed out|超时|Agent Worker request/i)
  } finally {
    await browser.close()
  }
})

async function assistantMessageCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const snapshot = await window.barn.threads.getSnapshot()
    return snapshot.messages.filter((message) => message.role === 'assistant').length
  })
}

async function waitForAssistantCount(page: Page, count: number): Promise<void> {
  await expect.poll(() => assistantMessageCount(page), {
    timeout: 240_000,
    intervals: [1_000, 2_000, 5_000],
  }).toBeGreaterThanOrEqual(count)
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const snapshot = await window.barn.threads.getSnapshot()
    const message = snapshot.messages.findLast((entry) => entry.role === 'assistant')
    if (message === undefined) return ''
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content.flatMap((part) => {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) return []
      const record = part as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
    }).join('\n')
  })
}
