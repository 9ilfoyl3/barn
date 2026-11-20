import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('draws one continuous guide for consecutive replies and quotes the lower question', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-reply-guide-e2e-'))
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
      await window.barn.threads.appendMessage({
        role: 'user',
        content: '查出门天气',
        metadata: { routerRequestId: 'guide-r1' },
      })
      await window.barn.threads.appendMessage({
        role: 'user',
        content: '查查上海的天气',
        metadata: { routerRequestId: 'guide-r2' },
      })
      await window.barn.threads.appendMessage({
        role: 'assistant',
        content: '南京明早出门时体感偏冷，建议穿厚外套。',
        metadata: { routerRequestId: 'guide-r1' },
      })
      await window.barn.threads.appendMessage({
        role: 'assistant',
        content: '上海今晚受冷空气影响，风大且体感更冷。',
        metadata: { routerRequestId: 'guide-r2' },
      })
    })

    await expect(page.locator('.assistant-reply-run')).toHaveCount(1)
    await expect(page.locator('.chat-message.assistant')).toHaveCount(2)
    await expect(page.locator('.assistant-reply-quote')).toHaveCount(1)
    await expect(page.locator('.assistant-reply-quote')).toContainText('查查上海的天气')

    await page.waitForTimeout(240)
    const placement = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll<HTMLElement>('.chat-message.assistant')]
      const users = [...document.querySelectorAll<HTMLElement>('.chat-message.user')]
      const quote = document.querySelector<HTMLElement>('.assistant-reply-quote')
      const run = document.querySelector<HTMLElement>('.assistant-reply-run')
      const guideStyle = run === null ? null : getComputedStyle(run, '::before')
      const guideLeft = guideStyle === null ? 0 : Number.parseFloat(guideStyle.left)
      return {
        firstBottom: bubbles[0]?.getBoundingClientRect().bottom ?? 0,
        quoteTop: quote?.getBoundingClientRect().top ?? 0,
        quoteBottom: quote?.getBoundingClientRect().bottom ?? 0,
        secondTop: bubbles[1]?.getBoundingClientRect().top ?? 0,
        runLeft: run?.getBoundingClientRect().left ?? 0,
        bubbleLeft: bubbles[0]?.getBoundingClientRect().left ?? 0,
        quoteLeft: quote?.getBoundingClientRect().left ?? 0,
        guideLeft,
        guideWidth: guideStyle === null ? 0 : Number.parseFloat(guideStyle.borderLeftWidth),
        guideTop: guideStyle === null ? 0 : Number.parseFloat(guideStyle.top),
        runTop: run?.getBoundingClientRect().top ?? 0,
        firstUserCenter: (users[0]?.getBoundingClientRect().top ?? 0) + (users[0]?.getBoundingClientRect().height ?? 0) / 2,
        sourceMessageKey: run?.dataset.sourceMessageKey,
        firstUserKey: users[0]?.dataset.messageKey,
      }
    })
    expect(placement.firstBottom).toBeLessThanOrEqual(placement.quoteTop)
    expect(placement.quoteBottom).toBeLessThanOrEqual(placement.secondTop)
    expect(placement.runLeft + placement.guideLeft).toBeGreaterThanOrEqual(placement.bubbleLeft + 18)
    expect(placement.quoteLeft - (placement.runLeft + placement.guideLeft + placement.guideWidth)).toBeGreaterThanOrEqual(3.5)
    expect(placement.guideWidth).toBeGreaterThanOrEqual(2)
    expect(placement.sourceMessageKey).toBe(placement.firstUserKey)
    expect(Math.abs(placement.runTop + placement.guideTop - placement.firstUserCenter)).toBeLessThanOrEqual(1)

    await page.waitForTimeout(220)
    await page.screenshot({ path: 'test-results/barn-reply-guide.png', fullPage: true })
  } finally {
    await app.close()
  }
})
