import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('keeps the composer single-line and vertically aligned after typing and deleting', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-composer-input-e2e-'))
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
      await window.barn.threads.appendMessage({ role: 'user', content: '查看今天的科技新闻。', metadata: { routerRequestId: 'composer-spacing-r1' } })
      await window.barn.threads.appendMessage({ role: 'assistant', content: '这是今天的科技新闻摘要，用于检查输入框增高后的消息间距。', metadata: { routerRequestId: 'composer-spacing-r1' } })
    })
    await expect(page.locator('.chat-message.assistant')).toBeVisible()
    const editor = page.locator('.prompt-input-editor')
    const form = page.locator('.barn-prompt-inline')

    const initial = await page.evaluate(() => {
      const center = (selector: string): number => {
        const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        return rect === undefined ? 0 : rect.top + rect.height / 2
      }
      const editorRect = document.querySelector<HTMLElement>('.prompt-input-editor')!.getBoundingClientRect()
      const formRect = document.querySelector<HTMLElement>('.barn-prompt-inline')!.getBoundingClientRect()
      return {
        editorHeight: editorRect.height,
        formHeight: formRect.height,
        centers: [
          center('.barn-prompt-inline button[aria-label="附件"]'),
          center('.prompt-input-editor'),
          center('.barn-prompt-inline .composer-model'),
          center('.barn-prompt-inline button[aria-label="发送消息"]'),
        ],
      }
    })
    expect(Math.max(...initial.centers) - Math.min(...initial.centers)).toBeLessThanOrEqual(1)

    for (let attempt = 0; attempt < 3; attempt++) {
      await editor.click()
      await page.keyboard.type(`第${attempt + 1}次输入稳定性测试`)
      await expect(editor).toHaveAttribute('data-empty', 'false')
      await page.keyboard.press('Meta+A')
      await page.keyboard.press('Backspace')
      await expect(editor).toHaveAttribute('data-empty', 'true')
      await expect(editor).toHaveText('')

      const afterDelete = await page.evaluate(() => {
        const editorElement = document.querySelector<HTMLElement>('.prompt-input-editor')!
        const formElement = document.querySelector<HTMLElement>('.barn-prompt-inline')!
        return {
          editorHeight: editorElement.getBoundingClientRect().height,
          formHeight: formElement.getBoundingClientRect().height,
          html: editorElement.innerHTML,
        }
      })
      expect(afterDelete.html).toBe('')
      expect(Math.abs(afterDelete.editorHeight - initial.editorHeight)).toBeLessThanOrEqual(1)
      expect(Math.abs(afterDelete.formHeight - initial.formHeight)).toBeLessThanOrEqual(1)
    }

    await editor.fill('输入框元素对齐检查')
    const alignedCenters = await page.evaluate(() => {
      const center = (selector: string): number => {
        const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        return rect === undefined ? 0 : rect.top + rect.height / 2
      }
      return [
        center('.barn-prompt-inline button[aria-label="附件"]'),
        center('.prompt-input-editor'),
        center('.barn-prompt-inline .composer-model'),
        center('.barn-prompt-inline button[aria-label="发送消息"]'),
      ]
    })
    expect(Math.max(...alignedCenters) - Math.min(...alignedCenters)).toBeLessThanOrEqual(1)

    await editor.fill('这是一段用于验证多行输入布局的较长内容。当文字换行以后，输入区域应该移动到上方，附件、模型和发送按钮移动到下方工具栏，并保持稳定。')
    await expect(form).toHaveAttribute('data-multiline', 'true')
    await page.waitForTimeout(320)
    const multiline = await page.evaluate(() => {
      const editorRect = document.querySelector<HTMLElement>('.prompt-input-editor')!.getBoundingClientRect()
      const toolbarRect = document.querySelector<HTMLElement>('.barn-prompt-inline > div:last-child')!.getBoundingClientRect()
      const bubbleRect = document.querySelector<HTMLElement>('.chat-message.assistant')!.getBoundingClientRect()
      const promptRect = document.querySelector<HTMLElement>('.barn-prompt-inline')!.getBoundingClientRect()
      return {
        editorBottom: editorRect.bottom,
        toolbarTop: toolbarRect.top,
        messageGap: promptRect.top - bubbleRect.bottom,
      }
    })
    expect(multiline.toolbarTop).toBeGreaterThanOrEqual(multiline.editorBottom)
    expect(multiline.messageGap).toBeGreaterThanOrEqual(12)
    expect(multiline.messageGap).toBeLessThanOrEqual(32)
    await page.screenshot({ path: 'test-results/barn-composer-multiline.png', fullPage: true })

    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await expect(form).toHaveAttribute('data-multiline', 'false')
    await page.screenshot({ path: 'test-results/barn-composer-input-alignment.png', fullPage: true })
  } finally {
    await app.close()
  }
})
