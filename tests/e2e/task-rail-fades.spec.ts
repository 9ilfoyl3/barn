import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('shows top and bottom task fades only where more cards are hidden', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-task-fades-e2e-'))
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
      for (let index = 1; index <= 9; index++) {
        const task = await window.barn.tasks.create({
          title: `已完成任务 ${index}`,
          origin: 'user',
          status: 'queued',
        })
        await window.barn.tasks.updateStatus(task.id, { status: 'running' })
        await window.barn.tasks.updateStatus(task.id, { status: 'completed' })
      }
    })
    await page.getByRole('button', { name: '已完成', exact: true }).click()
    await expect(page.locator('.task-rail-card')).toHaveCount(9)
    await page.waitForTimeout(250)

    const topFade = page.locator('.task-rail-fade-top')
    const bottomFade = page.locator('.task-rail-fade-bottom')
    await expect(topFade).toHaveAttribute('data-visible', 'false')
    await expect(bottomFade).toHaveAttribute('data-visible', 'true')
    await expect(topFade).toHaveCSS('right', '12px')
    await expect(bottomFade).toHaveCSS('right', '12px')

    const scroll = page.locator('.task-rail-scroll')
    const position = await scroll.evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }))
    expect(position.scrollHeight).toBeGreaterThan(position.clientHeight)
    await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await page.waitForTimeout(250)

    await expect(topFade).toHaveAttribute('data-visible', 'true')
    await expect(bottomFade).toHaveAttribute('data-visible', 'false')
    await page.screenshot({ path: 'test-results/barn-task-fades-bottom.png', fullPage: true })

    await scroll.evaluate((node) => { node.scrollTop = 0 })
    await page.waitForTimeout(250)
    await expect(topFade).toHaveAttribute('data-visible', 'false')
    await expect(bottomFade).toHaveAttribute('data-visible', 'true')
    await expect(topFade).toHaveCSS('right', '12px')
    await expect(bottomFade).toHaveCSS('right', '12px')
    await page.screenshot({ path: 'test-results/barn-task-fades-top.png', fullPage: true })
  } finally {
    await app.close()
  }
})
