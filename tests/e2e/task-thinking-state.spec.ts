import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('represents a running task as one Thinking Orbs state and adds the guide only after completion', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-thinking-e2e-'))
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
    const title = '汇总近期科技新闻简报'
    const taskId = await page.evaluate(async (taskTitle) => {
      const task = await window.barn.tasks.create({
        title: taskTitle,
        origin: 'user',
        status: 'queued',
      })
      await window.barn.tasks.updateStatus(task.id, { status: 'running' })
      await window.barn.threads.appendMessage({
        role: 'user',
        content: '帮我看下最近有什么科技新闻',
        metadata: { routerRequestId: 'task-thinking-r1' },
      })
      await window.barn.threads.appendMessage({
        role: 'assistant',
        content: `我已将“${taskTitle}”加入任务队列。`,
        metadata: {
          routerRequestId: 'task-thinking-r1',
          taskId: task.id,
          resultCard: {
            version: 1,
            kind: 'task',
            title: taskTitle,
            description: 'Barn 已将这项工作加入持久任务队列，进度可在右侧任务中查看。',
            provider: 'Barn',
            status: '执行中',
            meta: '由 Router 委派',
          },
        },
      })
      return task.id
    }, title)

    await expect(page.locator('.assistant-live-activity .barn-thinking-indicator')).toContainText('正在执行任务')
    await expect(page.locator('.assistant-live-activity .barn-thinking-indicator')).toContainText(title)
    await expect(page.locator('.assistant-reply-run')).toHaveCount(0)
    await expect(page.locator('.chat-message.assistant')).toHaveCount(0)
    await page.waitForTimeout(240)
    const spacing = await page.evaluate(() => {
      const activity = document.querySelector('.assistant-live-activity')?.getBoundingClientRect()
      const prompt = document.querySelector('.barn-prompt-inline')?.getBoundingClientRect()
      return { activityBottom: activity?.bottom ?? 0, promptTop: prompt?.top ?? 0 }
    })
    expect(spacing.promptTop - spacing.activityBottom).toBeGreaterThanOrEqual(12)
    expect(spacing.promptTop - spacing.activityBottom).toBeLessThanOrEqual(32)
    await page.screenshot({ path: 'test-results/barn-task-thinking-running.png', fullPage: true })

    await page.evaluate(async (id) => {
      await window.barn.tasks.updateStatus(id, { status: 'completed' })
    }, taskId)

    await expect(page.locator('.barn-thinking-indicator')).toHaveCount(0)
    await expect(page.locator('.chat-message.assistant')).toHaveCount(0)
    await expect(page.locator('.assistant-reply-run')).toHaveCount(0)

    await page.screenshot({ path: 'test-results/barn-task-thinking-state.png', fullPage: true })
  } finally {
    await app.close()
  }
})
