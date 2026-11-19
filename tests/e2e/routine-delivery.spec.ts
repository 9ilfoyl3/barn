import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('delivers a due routine as a chat message without placing it in Tasks', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-routine-delivery-e2e-'))
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
    await page.evaluate(async () => {
      await window.barn.tasks.create({
        title: '提醒：带衣服',
        origin: 'user',
        kind: 'reminder',
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
        prompt: '提醒我带衣服。',
        visiblePrompt: '提醒我带衣服。',
      })
    })

    await expect.poll(async () => page.evaluate(async () => (
      await window.barn.threads.getSnapshot()
    ).messages.some((message) => message.metadata.routineDelivery === true))).toBe(true)
    const routineMessage = await page.evaluate(async () => (
      await window.barn.threads.getSnapshot()
    ).messages.find((message) => message.metadata.routineDelivery === true))
    expect(routineMessage).toMatchObject({
      role: 'assistant',
      content: '提醒：带衣服。',
      metadata: expect.objectContaining({ routineDelivery: true }),
    })
    await expect(page.locator('.assistant-reply-run')).toHaveCount(0)
    await expect(page.locator('.proactive-message')).toContainText('提醒：带衣服。')
    await expect(page.locator('.routine-card')).toContainText('提醒：带衣服')
    await expect(page.locator('.routine-card')).toContainText('提醒我带衣服。')
    await expect(page.locator('.routine-card')).toContainText('已推送')
    await page.locator('.routine-card').hover()
    await expect(page.locator('.routine-card-acknowledge')).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-routine-card.png', fullPage: true })
    await page.locator('.routine-card-open').click()
    await expect(page.locator('.routine-card')).toHaveCount(1)
    const acknowledge = page.locator('.routine-card-acknowledge')
    await acknowledge.click()
    await expect(acknowledge).toHaveClass(/is-confirming/)
    await page.waitForTimeout(220)
    const confirmingColors = await acknowledge.evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.position = 'fixed'
      probe.style.background = 'var(--green)'
      document.body.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      const actual = getComputedStyle(element as HTMLElement).backgroundColor
      probe.remove()
      return { actual, expected }
    })
    expect(confirmingColors.actual).toBe(confirmingColors.expected)
    await page.screenshot({ path: 'test-results/barn-routine-card-confirming.png', fullPage: true })
    await expect(page.locator('.routine-card')).toHaveCount(0)
    await expect(page.locator('.proactive-message')).toContainText('提醒：带衣服。')
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.routine-card')).toHaveCount(0)
    await expect(page.locator('.proactive-message')).toContainText('提醒：带衣服。')
    await expect(page.locator('.task-rail-card')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/barn-routine-delivery.png', fullPage: true })
  } finally {
    await app.close()
  }
})
