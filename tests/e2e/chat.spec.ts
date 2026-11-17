import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('streams a multi-turn conversation through the Agent Worker', async () => {
  let requestCount = 0
  const server = await startMockModelServer(() => {
    requestCount++
    return `Barn reply ${requestCount}`
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-chat-e2e-'))
  const attachmentId = '9591d5dd-cd5d-497f-ab9a-255f015cbd2d'
  const attachmentPath = join(userData, 'workspace', `${attachmentId}-contract.pdf`)
  await mkdir(join(userData, 'workspace'), { recursive: true })
  await writeFile(attachmentPath, 'test attachment')
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
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'mock-provider',
        name: 'Mock Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'mock-model',
          name: 'Mock Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({
        providerId: 'mock-provider',
        apiKey: 'test-key',
      })
      await window.barn.models.setDefault({
        providerId: 'mock-provider',
        modelId: 'mock-model',
      })
    }, baseUrl)

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, attachmentPath)

    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    await page.getByRole('dialog', { name: 'Attach' }).getByRole('button', { name: /Files and folders/ }).click()
    await expect(page.locator('.attachment-card.attachment-pdf')).toContainText('contract.pdf')
    expect(await page.evaluate(() => window.barn.sessions.list())).toHaveLength(0)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Hello')
    await composer.press('Enter')

    await expect(page.getByText('Barn reply 1').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByLabel('User message').getByText('Hello', { exact: true })).toBeVisible()
    await expect(page.locator('.message-attachment')).toContainText('contract.pdf')
    await expect(page.locator('.message-attachment')).not.toContainText(attachmentId)
    await expect(page.locator('.workspace-footer')).toHaveCount(0)
    await expect(page.getByText(attachmentPath, { exact: true })).toHaveCount(0)

    await composer.fill('Second turn')
    await composer.press('Enter')
    await expect(page.getByText('Barn reply 2').last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByLabel('User message').getByText('Second turn', { exact: true })).toBeVisible()
    const conversationLayout = await page.evaluate(() => {
      const surface = document.querySelector('.conversation-surface')!
      const view = document.querySelector('.conversation-view')!
      const dock = document.querySelector('.composer-dock')!
      const composerElement = document.querySelector('.barn-prompt-input')!
      const messageList = document.querySelector('.message-list')!
      const dockBackdrop = getComputedStyle(dock, '::before')
      return {
        surfaceRight: surface.getBoundingClientRect().right,
        viewRight: view.getBoundingClientRect().right,
        surfaceOverflowY: getComputedStyle(surface).overflowY,
        messageListOverflowY: getComputedStyle(messageList).overflowY,
        dockBackdropBackground: dockBackdrop.backgroundColor,
        dockBackdropBottom: dockBackdrop.bottom,
        dockBackdropHeight: dockBackdrop.height,
        composerShadow: getComputedStyle(composerElement).boxShadow,
      }
    })
    expect(conversationLayout.surfaceRight).toBeCloseTo(conversationLayout.viewRight, 0)
    expect(conversationLayout.surfaceOverflowY).toBe('auto')
    expect(conversationLayout.messageListOverflowY).toBe('visible')
    expect(conversationLayout.dockBackdropBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(conversationLayout.dockBackdropBottom).toBe('0px')
    expect(conversationLayout.dockBackdropHeight).toBe('14px')
    expect(conversationLayout.composerShadow).toBe('none')
    await page.screenshot({ path: 'test-results/barn-desktop-chat.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})


test('selects a working directory and attaches a folder', async () => {
  const server = await startMockModelServer(() => 'Folder inspected.')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-workspace-e2e-'))
  const workingDirectory = join(userData, 'selected-project')
  const attachmentFolder = join(userData, 'reference-folder')
  const pdfPath = join(userData, 'document.pdf')
  const imagePath = join(userData, 'preview.png')
  const textPath = join(userData, 'notes.md')
  await Promise.all([
    mkdir(workingDirectory, { recursive: true }),
    mkdir(attachmentFolder, { recursive: true }),
  ])
  await writeFile(join(workingDirectory, 'notes.txt'), 'working directory notes')
  await writeFile(join(attachmentFolder, 'reference.txt'), 'reference folder content')
  await writeFile(pdfPath, '%PDF-1.4 test')
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  await writeFile(textPath, '# Project notes\n\nReview the attached material before the meeting.\n')
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
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'workspace-provider',
        name: 'Workspace Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [{
          id: 'workspace-model',
          name: 'Workspace Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'workspace-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'workspace-provider', modelId: 'workspace-model' })
    }, baseUrl)

    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = (async (_window: unknown, options: { title?: string }) => {
        if (options.title === 'Choose current working directory') {
          return { canceled: false, filePaths: [paths.working] }
        }
        if (options.title === 'Add files and folders') {
          return { canceled: false, filePaths: [paths.attachment, paths.pdf, paths.image, paths.text] }
        }
        return { canceled: true, filePaths: [] }
      }) as typeof dialog.showOpenDialog
    }, { working: workingDirectory, attachment: attachmentFolder, pdf: pdfPath, image: imagePath, text: textPath })

    await page.getByRole('button', { name: 'Choose working folder' }).click()
    await expect(page.locator('.composer-project')).toContainText('selected-project')
    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    const addDialog = page.getByRole('dialog', { name: 'Attach' })
    await expect(addDialog).toBeVisible()
    const addPopoverMotion = await addDialog.evaluate((element) => {
      const style = getComputedStyle(element)
      return { transitionProperty: style.transitionProperty, zIndex: style.zIndex }
    })
    expect(addPopoverMotion.transitionProperty.length).toBeGreaterThan(0)
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/barn-composer-add-menu.png', fullPage: true })
    await addDialog.getByRole('button', { name: /Files and folders/ }).click()
    await expect(page.locator('.attachment-card.attachment-folder')).toContainText('reference-folder')
    await expect(page.locator('.attachment-card.attachment-pdf')).toContainText('document.pdf')
    await expect(page.locator('.attachment-card.attachment-image img')).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect(page.locator('.attachment-card.attachment-text .attachment-text-preview')).toContainText('Project notes')
    await expect(page.locator('.attachment-card')).toHaveCount(4)
    await expect(addDialog).toBeHidden()
    await page.waitForTimeout(250)
    const composerAlignment = await page.evaluate(() => {
      const workspace = document.querySelector('.composer-project')!.getBoundingClientRect()
      const composer = document.querySelector('.composer')!.getBoundingClientRect()
      return { bottomGap: composer.top - workspace.bottom }
    })
    expect(composerAlignment.bottomGap).toBeCloseTo(8, 0)
    await page.screenshot({ path: 'test-results/barn-composer-directory.png', fullPage: true })

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Inspect the attached folder.')
    await composer.press('Enter')
    await expect(page.getByText('Folder inspected.').last()).toBeVisible({ timeout: 15_000 })

    const sessions = await page.evaluate(() => window.barn.sessions.list())
    expect(sessions[0]?.workingDirectory).toBe(workingDirectory)
    const events = await page.evaluate((sessionId) => window.barn.sessions.getEvents(sessionId), sessions[0]!.id)
    const userEvent = events.find((event) => event.type === 'agent.message' && event.actor.kind === 'user')
    if (userEvent === undefined) throw new Error('User attachment event was not stored')
    expect(userEvent.data).toMatchObject({
      attachments: expect.arrayContaining([
        expect.objectContaining({ kind: 'directory', name: 'reference-folder' }),
        expect.objectContaining({ kind: 'file', name: 'document.pdf' }),
        expect.objectContaining({ kind: 'file', name: 'preview.png' }),
        expect.objectContaining({ kind: 'file', name: 'notes.md' }),
      ]),
    })
    const attachmentPath = (userEvent.data as { attachments: Array<{ path: string; name: string }> })
      .attachments.find((attachment) => attachment.name === 'reference-folder')!.path
    expect(await readFile(join(attachmentPath, 'reference.txt'), 'utf8')).toBe('reference folder content')

    await page.locator('.composer-project').hover()
    await expect(page.locator('.composer-project .delete-icon')).toBeVisible()
    await page.getByRole('button', { name: 'Clear current working directory' }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.barn.sessions.list())[0]?.workingDirectory))
      .toBeUndefined()
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

test('selects a configured model and reasoning effort from the composer', async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = await startMockModelServer(() => 'Reasoning reply', requests)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-picker-e2e-'))
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
    await page.evaluate(async (url) => {
      await window.barn.models.saveCustomProvider({
        id: 'reasoning-provider',
        name: 'Reasoning Provider',
        baseUrl: url,
        api: 'openai-completions',
        models: [
          {
            id: 'reasoning-model',
            name: 'Reasoning Model',
            contextWindow: 128_000,
            maxTokens: 8_000,
            reasoning: true,
            reasoningEfforts: ['low', 'high', 'max'],
            input: ['text'],
          },
          {
            id: 'fast-model',
            name: 'Fast Model',
            contextWindow: 64_000,
            maxTokens: 4_000,
            reasoning: false,
            reasoningEfforts: [],
            input: ['text'],
          },
        ],
      })
      await window.barn.models.saveCredential({
        providerId: 'reasoning-provider',
        apiKey: 'test-key',
      })
      await window.barn.models.setDefault({
        providerId: 'reasoning-provider',
        modelId: 'reasoning-model',
        reasoningEffort: 'high',
      })
    }, baseUrl)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await page.locator('.composer-model').click()
    await expect(page.locator('#composer-model-picker')).toHaveClass(/open/)
    await expect(page.locator('.model-picker-menu-row')).toHaveCount(2)
    await expect(page.locator('.model-picker-menu-row.active')).toHaveCount(0)
    await expect(page.locator('.model-picker-submenu')).toHaveCount(0)
    const menu = page.locator('#composer-model-picker .model-picker-menu')
    await page.waitForTimeout(300)
    const initialMenuBox = await menu.boundingBox()
    if (initialMenuBox === null) throw new Error('Model picker menu did not render')
    await page.locator('.model-picker-menu-row').first().hover()
    await expect(page.locator('.model-picker-submenu')).toBeVisible()
    const modelSubmenuMotion = await page.locator('.model-picker-submenu').evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        className: element.className,
        animationName: style.animationName,
        animationDuration: Number.parseFloat(style.animationDuration),
      }
    })
    expect(modelSubmenuMotion.className).toContain('secondary-menu')
    expect(modelSubmenuMotion.animationName).toContain('secondary-menu-enter')
    expect(modelSubmenuMotion.animationDuration).toBeGreaterThan(0)
    await expect(page.getByText('Choose model', { exact: true })).toBeVisible()
    await expect(page.locator('.model-picker-submenu input')).toHaveCount(0)
    await expect(page.locator('.model-option small')).toHaveCount(0)
    await expect(page.locator('.model-option')).toHaveCount(2)
    await expect(page.getByRole('option', { name: /Reasoning Model/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Fast Model/ })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-model-list.png', fullPage: true })
    expect(await menu.boundingBox()).toEqual(initialMenuBox)
    const pickerClipping = await page.evaluate(() => ({
      viewOverflow: getComputedStyle(document.querySelector('.conversation-view')!).overflow,
      bodyOverflow: getComputedStyle(document.querySelector('.workspace-body')!).overflow,
    }))
    expect(pickerClipping).toEqual({ viewOverflow: 'visible', bodyOverflow: 'visible' })
    const pickerMotion = await page.locator('#composer-model-picker').evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        property: style.transitionProperty,
        duration: Number.parseFloat(style.transitionDuration),
      }
    })
    expect(pickerMotion.property).toContain('opacity')
    expect(pickerMotion.property).toContain('transform')
    expect(pickerMotion.duration).toBeGreaterThan(0)

    await page.locator('.model-picker-menu-row').nth(1).hover()
    const effortSlider = page.getByRole('slider', { name: 'Effort' })
    await expect(effortSlider).toBeVisible()
    await expect(page.locator('.effort-card-icon')).toHaveCount(0)
    await expect(page.locator('.effort-card').getByText('Effort', { exact: true })).toHaveCount(0)
    const effortLayout = await page.locator('.effort-card').evaluate((element) => {
      const panel = element.closest('.model-picker-submenu')!.getBoundingClientRect()
      const header = element.querySelector('.effort-card-header')!.getBoundingClientRect()
      const model = element.querySelector('.effort-card-model')!.getBoundingClientRect()
      const slider = element.querySelector('.effort-slider')!.getBoundingClientRect()
      const title = element.querySelector('.effort-card-title')!.getBoundingClientRect()
      return {
        topInset: header.top - panel.top,
        headerToModel: model.top - header.bottom,
        modelToSlider: slider.top - model.bottom,
        bottomInset: panel.bottom - slider.bottom,
        titleCenterOffset: Math.abs((title.left + title.right) / 2 - (header.left + header.right) / 2),
        modelCenterOffset: Math.abs((model.left + model.right) / 2 - (slider.left + slider.right) / 2),
      }
    })
    expect(effortLayout.topInset).toBeGreaterThanOrEqual(8)
    expect(effortLayout.headerToModel).toBeGreaterThanOrEqual(6)
    expect(effortLayout.modelToSlider).toBeGreaterThanOrEqual(8)
    expect(effortLayout.bottomInset).toBeGreaterThanOrEqual(6)
    expect(effortLayout.titleCenterOffset).toBeLessThan(1)
    expect(effortLayout.modelCenterOffset).toBeLessThan(1)
    expect(await menu.boundingBox()).toEqual(initialMenuBox)
    const panelLayout = await page.evaluate(() => {
      const panel = document.querySelector('.model-picker-submenu')!.getBoundingClientRect()
      const submenu = document.querySelector<HTMLElement>('.model-picker-submenu')!
      const menuRect = document.querySelector('#composer-model-picker .model-picker-menu')!.getBoundingClientRect()
      return {
        panelLeft: panel.left,
        panelRight: panel.right,
        panelWidth: panel.width,
        menuLeft: menuRect.left,
        menuRight: menuRect.right,
        side: submenu.dataset.side,
        viewportWidth: window.innerWidth,
      }
    })
    const expectedSide = panelLayout.viewportWidth - panelLayout.menuRight - 12
      >= panelLayout.panelWidth + 8
      ? 'right'
      : 'left'
    expect(panelLayout.side).toBe(expectedSide)
    if (expectedSide === 'right') {
      expect(panelLayout.panelLeft).toBeGreaterThan(panelLayout.menuRight)
    } else {
      expect(panelLayout.panelRight).toBeLessThan(panelLayout.menuLeft)
    }
    expect(panelLayout.panelWidth).toBeCloseTo(252, 0)
    expect(panelLayout.panelRight).toBeLessThanOrEqual(panelLayout.viewportWidth)
    expect(panelLayout.panelLeft).toBeGreaterThanOrEqual(0)
    const sliderBox = await effortSlider.boundingBox()
    if (sliderBox === null) throw new Error('Effort slider did not render')
    await page.mouse.click(sliderBox.x + 2, sliderBox.y + sliderBox.height / 2)
    await expect(page.locator('.effort-card-title strong')).toContainText('Low')
    await expect(page.locator('.composer-model')).toContainText('Low')
    await page.waitForTimeout(260)
    const minSliderGeometry = await page.evaluate(() => {
      const track = document.querySelector('.effort-slider')!.getBoundingClientRect()
      const thumb = document.querySelector('.effort-slider-thumb')!.getBoundingClientRect()
      return {
        top: thumb.top - track.top,
        bottom: track.bottom - thumb.bottom,
        left: thumb.left - track.left,
      }
    })
    expect(minSliderGeometry.top).toBeCloseTo(4, 1)
    expect(minSliderGeometry.bottom).toBeCloseTo(4, 1)
    expect(minSliderGeometry.left).toBeCloseTo(4, 1)
    await page.mouse.click(sliderBox.x + sliderBox.width * 0.52, sliderBox.y + sliderBox.height / 2)
    await expect(page.locator('.effort-card-title strong')).toContainText('High')
    const mediumFillGeometry = await page.evaluate(() => {
      const track = document.querySelector('.effort-slider')!.getBoundingClientRect()
      const fill = document.querySelector('.effort-slider-fill')!.getBoundingClientRect()
      const fillStyle = getComputedStyle(document.querySelector('.effort-slider-fill')!)
      const passedDots = document.querySelectorAll('.effort-slider-dot.passed')
      const currentDot = passedDots[passedDots.length - 1]?.getBoundingClientRect()
      return {
        trackWidth: track.width,
        fillWidth: fill.width,
        fillHeight: fill.height,
        dotRight: currentDot?.right ?? Number.NaN,
        fillRight: fill.right,
        radius: Number.parseFloat(fillStyle.borderRadius),
        transform: fillStyle.transform,
      }
    })
    expect(mediumFillGeometry.fillWidth).toBeGreaterThan(0)
    expect(mediumFillGeometry.fillWidth).toBeLessThan(mediumFillGeometry.trackWidth)
    expect(mediumFillGeometry.fillRight - mediumFillGeometry.dotRight).toBeGreaterThanOrEqual(3.5)
    expect(mediumFillGeometry.radius).toBeGreaterThanOrEqual(mediumFillGeometry.fillHeight / 2)
    expect(mediumFillGeometry.transform).toBe('none')
    await page.screenshot({ path: 'test-results/barn-effort-medium.png', fullPage: true })
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.96, sliderBox.y + sliderBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.98, sliderBox.y + sliderBox.height / 2, { steps: 4 })
    await page.mouse.up()
    await expect(page.locator('.effort-card-title strong')).toContainText('Max')
    await expect(effortSlider).toHaveAttribute('aria-valuetext', 'Max')
    await expect(page.locator('.composer-model')).toContainText('Max')
    await page.waitForTimeout(260)
    const sliderGeometry = await page.evaluate(() => {
      const track = document.querySelector('.effort-slider')!.getBoundingClientRect()
      const thumb = document.querySelector('.effort-slider-thumb')!.getBoundingClientRect()
      const fill = document.querySelector('.effort-slider-fill')!.getBoundingClientRect()
      return {
        top: thumb.top - track.top,
        right: track.right - thumb.right,
        bottom: track.bottom - thumb.bottom,
        fillWidth: fill.width,
        trackWidth: track.width,
      }
    })
    expect(sliderGeometry.top).toBeCloseTo(4, 1)
    expect(sliderGeometry.right).toBeCloseTo(4, 1)
    expect(sliderGeometry.bottom).toBeCloseTo(4, 1)
    expect(sliderGeometry.fillWidth).toBeCloseTo(sliderGeometry.trackWidth, 1)
    await page.screenshot({ path: 'test-results/barn-model-picker.png', fullPage: true })

    await page.keyboard.press('Escape')
    await expect(page.locator('#composer-model-picker')).not.toHaveClass(/open/)
    await expect(page.locator('.model-picker-submenu')).toHaveCount(0)
    await page.evaluate(() => {
      const picker = document.querySelector<HTMLElement>('.model-picker')!
      picker.style.transform = 'translateX(-420px)'
    })
    await page.locator('.composer-model').evaluate((element) => (element as HTMLElement).click())
    await expect(page.locator('#composer-model-picker')).toHaveClass(/open/)
    await page.locator('.model-picker-menu-row').nth(1).evaluate((element) => (element as HTMLElement).click())
    await expect(page.locator('.model-picker-submenu')).toHaveAttribute('data-side', 'right')
    const rightPlacement = await page.evaluate(() => {
      const panel = document.querySelector('.model-picker-submenu')!.getBoundingClientRect()
      const menuRect = document.querySelector('#composer-model-picker .model-picker-menu')!.getBoundingClientRect()
      return { panelLeft: panel.left, menuRight: menuRect.right }
    })
    expect(rightPlacement.panelLeft).toBeGreaterThan(rightPlacement.menuRight)
    const composer = page.getByLabel('Message Barn')
    await composer.focus()
    await expect(page.locator('#composer-model-picker')).not.toHaveClass(/open/)
    await expect(page.locator('.model-picker-submenu')).toHaveCount(0)

    await page.locator('.composer-model').evaluate((element) => (element as HTMLElement).click())
    await page.locator('.model-picker-menu-row').nth(1).evaluate((element) => (element as HTMLElement).click())
    await expect(page.locator('.model-picker-submenu')).toBeVisible()
    await page.mouse.click(8, 8)
    await expect(page.locator('#composer-model-picker')).not.toHaveClass(/open/)
    await expect(page.locator('.model-picker-submenu')).toHaveCount(0)

    await page.locator('.composer-model').evaluate((element) => (element as HTMLElement).click())
    await page.locator('.model-picker-menu-row').nth(1).evaluate((element) => (element as HTMLElement).click())
    await expect(page.locator('.model-picker-submenu')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(page.locator('#composer-model-picker')).not.toHaveClass(/open/)
    await expect(page.locator('.model-picker-submenu')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.model-picker')!.style.transform = ''
    })
    await composer.fill('Use max effort')
    await composer.press('Enter')
    await expect(page.getByText('Reasoning reply')).toBeVisible({ timeout: 15_000 })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      model: 'reasoning-model',
      reasoning_effort: 'max',
      stream: true,
    })
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

test('interleaves live thinking, tools, and content in event order', async () => {
  const mock = await startOrderedModelServer()
  const address = mock.server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-order-e2e-'))
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
    await page.evaluate(async (baseUrl) => {
      await window.barn.models.saveCustomProvider({
        id: 'ordered-provider',
        name: 'Ordered Provider',
        baseUrl,
        api: 'openai-responses',
        models: [{
          id: 'ordered-model',
          name: 'Ordered Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'ordered-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'ordered-provider', modelId: 'ordered-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Inspect the workspace.')
    await composer.press('Enter')

    await mock.secondStarted
    await expect.poll(() => page
      .locator('.live-turn .conversation-part')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-part'))))
      .toEqual(['tool-group', 'thinking'])
    await expect(page.locator('.live-turn .tool-group button').first()).toContainText('Listed a directory')

    mock.release()
    await expect(page.getByText('The workspace looks good.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const finalParts = await page
      .locator('.chat-message.assistant .conversation-part')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-part')))
    expect(finalParts).toEqual(['tool-group', 'thinking', 'text'])

    const toolGroup = page.locator('.chat-message.assistant .tool-group')
    const toolHeader = toolGroup.locator('button').first()
    const assistantWidths = await page.evaluate(() => {
      const message = document.querySelector('.chat-message.assistant')!.getBoundingClientRect().width
      const parts = document.querySelector('.chat-message.assistant .conversation-parts')!.getBoundingClientRect().width
      const tools = document.querySelector('.chat-message.assistant .tool-group')!.getBoundingClientRect().width
      return { message, parts, tools }
    })
    expect(assistantWidths.parts).toBeCloseTo(assistantWidths.message, 0)
    expect(assistantWidths.tools).toBeCloseTo(assistantWidths.message, 0)
    await expect(toolHeader).toBeVisible()
    if (await toolHeader.getAttribute('aria-expanded') === 'false') await toolHeader.click()
    await expect(toolHeader).toHaveAttribute('aria-expanded', 'true')
    const toolRow = toolGroup.locator('.beautiful-tool-chip-row')
    await expect(toolRow).toHaveCount(1)
    await expect(toolRow).toContainText('List Dir')
    await toolRow.click()
    const detail = toolGroup.locator('.beautiful-tool-chip-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('"path": "."')
    await page.waitForTimeout(350)
    await page.screenshot({ path: 'test-results/barn-ordered-stream.png', fullPage: true })
  } finally {
    mock.release()
    await app.close()
    await new Promise<void>((resolve, reject) => mock.server.close((error) => error === undefined ? resolve() : reject(error)))
  }
})

async function startMockModelServer(
  nextReply: () => string,
  requests: Array<Record<string, unknown>> = [],
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (body.length > 0) requests.push(JSON.parse(body) as Record<string, unknown>)
      const text = nextReply()
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-${text}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function startOrderedModelServer(): Promise<{
  server: Server
  secondStarted: Promise<void>
  release: () => void
}> {
  let requestCount = 0
  let notifySecondStarted: (() => void) | undefined
  let releaseSecond: (() => void) | undefined
  const secondStarted = new Promise<void>((resolve) => { notifySecondStarted = resolve })
  const released = new Promise<void>((resolve) => { releaseSecond = resolve })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', async () => {
      requestCount++
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (requestCount === 1) {
        sendResponseFunctionCall(response, 'list_dir', { path: '.' }, 'call-list')
        return
      }
      const reasoning = {
        id: 'reasoning-order',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'I inspected the workspace.' }],
      }
      sendEvent(response, {
        type: 'response.created',
        response: { id: 'resp-order', status: 'in_progress', output: [] },
      })
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...reasoning, summary: [] },
      })
      sendEvent(response, {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: reasoning.id,
        summary_index: 0,
        delta: 'I inspected the workspace.',
      })
      notifySecondStarted?.()
      await released
      sendEvent(response, {
        type: 'response.output_item.done',
        output_index: 0,
        item: reasoning,
      })
      const item = {
        id: 'message-order',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The workspace looks good.', annotations: [] }],
      }
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...item, status: 'in_progress', content: [] },
      })
      sendEvent(response, {
        type: 'response.output_text.delta',
        output_index: 1,
        item_id: item.id,
        content_index: 0,
        delta: 'The workspace looks good.',
      })
      sendEvent(response, { type: 'response.output_item.done', output_index: 1, item })
      sendEvent(response, {
        type: 'response.completed',
        response: {
          id: 'resp-order',
          status: 'completed',
          output: [reasoning, item],
          usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
        },
      })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    secondStarted,
    release: () => releaseSecond?.(),
  }
}

function sendResponseFunctionCall(
  response: import('node:http').ServerResponse,
  name: string,
  args: Record<string, unknown>,
  callId: string,
): void {
  const item = {
    id: `fc-${callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  }
  sendEvent(response, {
    type: 'response.created',
    response: { id: `resp-${callId}`, status: 'in_progress', output: [] },
  })
  sendEvent(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', arguments: '' },
  })
  sendEvent(response, {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: item.id,
    delta: item.arguments,
  })
  sendEvent(response, {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: item.id,
    arguments: item.arguments,
  })
  sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
  sendEvent(response, {
    type: 'response.completed',
    response: {
      id: `resp-${callId}`,
      status: 'completed',
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  })
  response.end('data: [DONE]\n\n')
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
