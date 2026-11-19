import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('opens a persisted conversation scrolled to the latest message', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-conversation-scroll-e2e-'))
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
      for (let index = 1; index <= 8; index++) {
        await window.barn.threads.appendMessage({
          role: 'user',
          content: `第 ${index} 个问题：请检查重新打开会话后是否默认停留在最新消息。`,
          metadata: { routerRequestId: `scroll-r${index}` },
        })
        await window.barn.threads.appendMessage({
          role: 'assistant',
          content: `第 ${index} 条回复。\n\n这里加入足够长的内容，用来确保消息列表超过一屏，并验证应用重新打开时不会停留在最早的历史消息。\n\n再补充一段内容用于稳定布局高度。`,
          metadata: { routerRequestId: `scroll-r${index}` },
        })
      }
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.chat-message.user')).toHaveCount(8)
    await expect.poll(async () => page.locator('.conversation-surface').evaluate(
      (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
    )).toBeLessThanOrEqual(2)

    const scroll = await page.locator('.conversation-surface').evaluate((node) => ({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }))
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
    expect(scroll.scrollTop + scroll.clientHeight).toBeGreaterThanOrEqual(scroll.scrollHeight - 2)
    await expect(page.locator('.conversation-fade-top')).toHaveAttribute('data-visible', 'true')
    await expect(page.locator('.conversation-fade-top')).toHaveCSS('right', '12px')
    await expect(page.locator('.conversation-fade-bottom')).toHaveCSS('right', '12px')
    await expect(page.locator('.conversation-fade-bottom')).toHaveAttribute('data-visible', 'false')

    await page.screenshot({ path: 'test-results/barn-conversation-scroll-bottom.png', fullPage: true })

    await page.locator('.conversation-surface').evaluate((node) => { node.scrollTop = 0 })
    await page.waitForTimeout(220)
    await expect(page.locator('.conversation-fade-top')).toHaveAttribute('data-visible', 'false')
    await expect(page.locator('.conversation-fade-bottom')).toHaveAttribute('data-visible', 'true')
    await page.screenshot({ path: 'test-results/barn-conversation-scroll-top.png', fullPage: true })
  } finally {
    await app.close()
  }
})
