import { chromium, expect, test } from '@playwright/test'

const cdpUrl = process.env.BARN_LIVE_CDP_URL
const liveGroup = process.env.BARN_LIVE_DINGTALK_GROUP

test.skip(cdpUrl === undefined || liveGroup === undefined, 'Set BARN_LIVE_CDP_URL and BARN_LIVE_DINGTALK_GROUP for the live DingTalk watch test')
test.setTimeout(600_000)

test('reads live DingTalk group messages with the configured connector and model without sending', async () => {
  const group = liveGroup!
  const browser = await chromium.connectOverCDP(cdpUrl!)
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('out/renderer/index.html') || candidate.url().startsWith('http://localhost'))
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
    expect(watch?.config.kind === 'dingtalk' ? watch.config.purpose : undefined).toBe('analysis')
    expect(watch?.config.kind === 'dingtalk' ? watch.config.mode : undefined).toBe('active')

    await page.evaluate(() => window.barn.connectorSources.pollNow())
    await expect.poll(async () => page.evaluate(async (sourceId) => (
      await window.barn.connectorSources.listEvents(sourceId, 100)
    ).length, watch!.id), { timeout: 60_000 }).toBeGreaterThan(0)
    expect(await page.evaluate(async (sourceId) => (
      await window.barn.connectorSources.listEvents(sourceId, 100)
    ).every((event) => event.kind === 'dingtalk_message'), watch!.id)).toBe(true)

    const beforeEvents = await page.evaluate(async (sourceId) => (
      await window.barn.connectorSources.listEvents(sourceId, 100)
    ).map((event) => event.id), watch!.id)
    const beforeEventIds = new Set(beforeEvents)
    const beforeRoutines = await page.evaluate(() => window.barn.routines.list())
    const beforeRoutineIds = new Set(beforeRoutines.map((notification) => notification.id))
    const tasksBefore = await page.evaluate(async () => (await window.barn.tasks.list()).length)
    const routerRequestsBefore = await page.evaluate(async () => (await window.barn.router.getSnapshot()).requests.length)

    await expect.poll(async () => {
      await page.evaluate(() => window.barn.connectorSources.pollNow())
      return page.evaluate(async ({ sourceId, eventIds, routineIds }) => {
        const events = await window.barn.connectorSources.listEvents(sourceId, 100)
        const routines = await window.barn.routines.list()
        return events.some((event) => !eventIds.includes(event.id))
          || routines.some((notification) => !routineIds.includes(notification.id))
      }, {
        sourceId: watch!.id,
        eventIds: [...beforeEventIds],
        routineIds: [...beforeRoutineIds],
      })
    }, { timeout: 360_000, intervals: [10_000, 15_000, 30_000] }).toBe(true)

    await expect.poll(async () => page.evaluate(async (routineIds) => (
      await window.barn.routines.list()
    ).some((notification) => !routineIds.includes(notification.id)), [...beforeRoutineIds]), {
      timeout: 180_000,
      intervals: [2_000, 5_000, 10_000],
    }).toBe(true)
    const routine = await page.evaluate(async (routineIds) => (
      await window.barn.routines.list()
    ).find((notification) => !routineIds.includes(notification.id)), [...beforeRoutineIds])
    expect(routine).toMatchObject({ provider: 'dingtalk', sourceLabel: 'DingTalk' })
    expect(routine?.body.trim().length).toBeGreaterThan(30)
    expect(await page.evaluate(async () => (await window.barn.tasks.list()).length)).toBe(tasksBefore)
    expect(await page.evaluate(async () => (await window.barn.router.getSnapshot()).requests.length)).toBe(routerRequestsBefore)
    await page.locator('.app-rail-button').first().click()
    await expect(page.locator('.routine-card', { hasText: routine!.title })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-live-dingtalk-routine.png', fullPage: true })

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
