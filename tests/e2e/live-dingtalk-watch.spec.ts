import { chromium, expect, test } from '@playwright/test'

const cdpUrl = process.env.BARN_LIVE_CDP_URL
const liveGroup = process.env.BARN_LIVE_DINGTALK_GROUP

test.skip(cdpUrl === undefined || liveGroup === undefined, 'Set BARN_LIVE_CDP_URL and BARN_LIVE_DINGTALK_GROUP for the live DingTalk watch test')
test.setTimeout(360_000)

test('reads live DingTalk group messages with the configured connector and model without sending', async () => {
  const group = liveGroup!
  const browser = await chromium.connectOverCDP(cdpUrl!)
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0]
    if (page === undefined) throw new Error('Barn has no page over CDP')
    await page.waitForLoadState('domcontentloaded')

    const snapshot = await page.evaluate(() => window.barn.models.getSnapshot())
    expect(snapshot.defaultModel).toBeDefined()
    const connectors = await page.evaluate(() => window.barn.connectors.list())
    expect(connectors.find((connector) => connector.kind === 'dingtalk')).toMatchObject({ status: 'ready' })
    const actionsBefore = await page.evaluate(() => window.barn.connectors.listActions())

    let watch = await page.evaluate(async (expected) => {
      const sources = await window.barn.connectorSources.list()
      return sources.find((source) => source.config.kind === 'dingtalk'
        && ((source.config.targetLabel ?? '').includes(expected) || source.name.includes(expected)))
    }, group)
    if (watch === undefined) {
      await page.locator('.app-rail-button').first().click()
      const composer = page.getByLabel('给 Barn 发消息')
      await composer.fill(`帮我关注钉钉“${group}”群的所有群消息，只关注群消息，不要个人待办。重点分析项目、部署、失败、异常相关内容，分析后告诉我。不要代我发消息。`)
      await composer.press('Enter')
      await expect.poll(async () => page.evaluate(async (expected) => {
        const sources = await window.barn.connectorSources.list()
        return sources.some((source) => source.config.kind === 'dingtalk'
          && ((source.config.targetLabel ?? '').includes(expected) || source.name.includes(expected)))
      }, group), { timeout: 120_000 }).toBe(true)
      watch = await page.evaluate(async (expected) => {
        const sources = await window.barn.connectorSources.list()
        return sources.find((source) => source.config.kind === 'dingtalk'
          && ((source.config.targetLabel ?? '').includes(expected) || source.name.includes(expected)))
      }, group)
    }
    expect(watch).toBeDefined()
    expect(watch?.config.kind === 'dingtalk' ? watch.config.events : []).toEqual(['messages'])

    await page.evaluate(() => window.barn.connectorSources.pollNow())
    await expect.poll(async () => page.evaluate(async (sourceId) => (
      await window.barn.connectorSources.listEvents(sourceId, 100)
    ).length, watch!.id), { timeout: 60_000 }).toBeGreaterThan(0)
    expect(await page.evaluate(async (sourceId) => (
      await window.barn.connectorSources.listEvents(sourceId, 100)
    ).every((event) => event.kind === 'dingtalk_message'), watch!.id)).toBe(true)

    const assistantBefore = await page.evaluate(async () => (
      await window.barn.threads.getSnapshot()
    ).messages.filter((message) => message.role === 'assistant').length)
    await page.locator('.app-rail-button').first().click()
    const composer = page.getByLabel('给 Barn 发消息')
    await composer.fill(`只读查看钉钉群“${group}”最新 20 条群消息。请用不超过 400 字回答：主要项目、部署进展、是否有失败或异常、需要我处理的风险。不要创建任务，不要发消息。`)
    await composer.press('Enter')
    await expect.poll(async () => page.evaluate(async () => (
      await window.barn.threads.getSnapshot()
    ).messages.filter((message) => message.role === 'assistant').length), { timeout: 180_000 }).toBeGreaterThan(assistantBefore)

    const lastAssistant = await page.evaluate(async () => (
      await window.barn.threads.getSnapshot()
    ).messages.filter((message) => message.role === 'assistant').at(-1)?.content)
    expect(typeof lastAssistant === 'string' ? lastAssistant.length : 0).toBeGreaterThan(100)
    await page.screenshot({ path: 'test-results/barn-live-dingtalk-analysis.png', fullPage: true })

    const checkedAt = watch?.lastCheckedAt
    await page.waitForTimeout(2_000)
    await page.evaluate(() => window.barn.connectorSources.pollNow())
    const later = await page.evaluate(async (sourceId) => (
      await window.barn.connectorSources.list()
    ).find((source) => source.id === sourceId), watch!.id)
    expect(later?.lastCheckedAt).not.toBe(checkedAt)

    const actionsAfter = await page.evaluate(() => window.barn.connectors.listActions())
    expect(actionsAfter.filter((action) => !actionsBefore.some((before) => before.id === action.id))
      .some((action) => action.title.toLocaleLowerCase().includes('send'))).toBe(false)
  } finally {
    await browser.close()
  }
})
