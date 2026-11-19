import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('renders the sessionless personal-secretary workspace and structured results', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-secretary-visual-e2e-'))
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await page.evaluate(async () => {
      await window.barn.tasks.create({
        title: 'Review the Q4 planning note',
        origin: 'user',
        status: 'proposed',
      })
      await window.barn.tasks.create({
        title: 'Prepare the Monday briefing',
        origin: 'automation',
        status: 'proposed',
      })
      await window.barn.threads.appendMessage({
        role: 'user',
        content: 'What should I focus on today?',
      })
      await window.barn.threads.appendMessage({
        role: 'assistant',
        content: 'The Q4 planning note needs your review first. After that, the Monday briefing has one open decision that will unblock the rest of the work.',
        metadata: {
          resultCard: {
            version: 1,
            kind: 'task',
            title: 'Review the Q4 planning note',
            description: 'Confirm the launch date and leave a comment on the one unresolved decision.',
            provider: 'You',
            status: 'Needs review',
            meta: 'Updated recently',
          },
        },
      })
      await window.barn.threads.appendMessage({
        role: 'user',
        content: 'Draft a short reply and keep the tone direct.',
      })
      await window.barn.threads.appendMessage({
        role: 'assistant',
        content: 'I’ve drafted a direct reply that confirms the timeline and asks for a response by noon.',
      })
    })

    await expect(page.locator('.assistant-result')).toBeVisible()
    await expect(page.locator('.assistant-result')).toContainText('Review the Q4 planning note')
    await expect(page.locator('.secretary-shell')).toBeVisible()
    await expect(page.locator('.app-topbar .secretary-search')).toBeVisible()
    await expect(page.locator('.app-rail')).toBeVisible()
    await expect(page.locator('.routines-header')).toBeVisible()
    await expect(page.locator('.task-rail')).toBeVisible()
    await expect(page.locator('.barn-prompt-inline')).toBeVisible()

    const divider = page.locator('.home-pane-divider-routines')
    const dividerLine = divider.locator('.home-pane-divider-line')
    await expect.poll(async () => dividerLine.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
    await expect.poll(async () => {
      const box = await divider.boundingBox()
      if (box === null) return false
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      return divider.evaluate((node) => node.matches(':hover'))
    }, { timeout: 5000 }).toBe(true)
    await expect.poll(
      async () => dividerLine.evaluate((node) => getComputedStyle(node).opacity),
      { timeout: 3000 },
    ).toBe('1')

    await page.getByRole('button', { name: 'Completed', exact: true }).click()
    await expect(page.getByText('No completed tasks yet', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await expect(page.locator('.task-rail-card')).toHaveCount(2)
    await page.mouse.move(700, 40)
    await expect.poll(async () => dividerLine.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')

    const layout = await page.evaluate(() => {
      const rail = document.querySelector('.app-rail')!.getBoundingClientRect()
      const workspace = document.querySelector('.workspace-shell')!.getBoundingClientRect()
      const routines = document.querySelector('.today-home-column')!.getBoundingClientRect()
      const conversation = document.querySelector('.conversation-view')!.getBoundingClientRect()
      const tasks = document.querySelector('.task-rail')!.getBoundingClientRect()
      const messageList = document.querySelector('.message-list')!.getBoundingClientRect()
      const composerDock = document.querySelector('.composer-dock')!.getBoundingClientRect()
      return { rail, workspace, routines, conversation, tasks, messageList, composerDock }
    })
    expect(layout.rail.right).toBeLessThanOrEqual(layout.workspace.left)
    expect(layout.routines.right).toBeLessThanOrEqual(layout.conversation.left)
    expect(layout.conversation.right).toBeLessThanOrEqual(layout.tasks.left)
    expect(Math.abs(layout.messageList.width - layout.composerDock.width)).toBeLessThanOrEqual(1)
    await expect(page.locator('.session-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /New session/i })).toHaveCount(0)
    await expect(page.getByText('Side Chat', { exact: true })).toHaveCount(0)

    const palette = await page.evaluate(() => {
      const user = getComputedStyle(document.querySelector('.chat-message.user')!)
      const assistant = getComputedStyle(document.querySelector('.chat-message.assistant')!)
      return {
        userBackground: user.backgroundColor,
        userColor: getComputedStyle(document.querySelector('.chat-message.user .message-copy')!).color,
        assistantBackground: assistant.backgroundColor,
      }
    })
    expect(palette.userBackground).not.toBe(palette.assistantBackground)
    expect(palette.userColor).toBe('rgb(255, 255, 255)')

    await page.screenshot({ path: 'test-results/barn-secretary-final.png', fullPage: true })
  } finally {
    await app.close()
  }
})
