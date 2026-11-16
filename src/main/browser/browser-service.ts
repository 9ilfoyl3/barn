import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, WebContentsView } from 'electron'
import type { BrowserBounds, BrowserLiveEvent, BrowserState, BrowserTabState } from '../../shared/models'
import { isAllowedBrowserUrl, normalizeBrowserUrl } from './browser-policy'
import { collectPageSnapshot, performPageActions, readPageText, type PageAction, type PageSnapshot } from './page-script'

const browserPartition = 'persist:barn-agent-browser'

interface BrowserTab {
  id: string
  view: WebContentsView
  attached: boolean
  url: string
  title: string
  loading: boolean
}

export class BrowserService {
  private readonly browserSession = session.fromPartition(browserPartition)
  private readonly tabs: BrowserTab[] = []
  private activeTabId: string | undefined
  private lastBounds: BrowserBounds | undefined
  private openState = false
  private visibleState = false
  private error: string | undefined

  constructor(private readonly window: BrowserWindow) {
    this.browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    this.browserSession.setPermissionCheckHandler(() => false)
  }

  getState(): BrowserState {
    const active = this.activeTab()
    return {
      open: this.openState,
      visible: this.visibleState,
      url: active?.url ?? 'about:blank',
      title: active?.title ?? '',
      loading: active?.loading ?? false,
      canGoBack: active?.view.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: active?.view.webContents.navigationHistory.canGoForward() ?? false,
      ...(this.activeTabId === undefined ? {} : { activeTabId: this.activeTabId }),
      tabs: this.tabs.map((tab): BrowserTabState => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        loading: tab.loading,
        active: tab.id === this.activeTabId,
      })),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  open(url?: string): BrowserState {
    this.ensureTab()
    this.openState = true
    this.visibleState = true
    this.showActiveTab()
    if (url !== undefined) return this.navigate(url)
    this.emit()
    return this.getState()
  }

  close(): BrowserState {
    this.openState = false
    this.visibleState = false
    for (const tab of this.tabs) tab.view.setVisible(false)
    this.emit()
    return this.getState()
  }

  navigate(url: string): BrowserState {
    const tab = this.ensureTab()
    this.openState = true
    this.visibleState = true
    this.attachTab(tab)
    this.showActiveTab()
    const normalized = normalizeBrowserUrl(url)
    tab.url = normalized
    tab.loading = true
    this.error = undefined
    this.emit()
    void tab.view.webContents.loadURL(normalized).catch((error: unknown) => {
      tab.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
    })
    return this.getState()
  }

  newTab(url?: string): BrowserState {
    const tab = this.createTab(url === undefined ? 'about:blank' : normalizeBrowserUrl(url))
    this.activeTabId = tab.id
    this.openState = true
    this.visibleState = true
    this.showActiveTab()
    this.emit()
    return this.getState()
  }

  activateTab(tabId: string): BrowserState {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (tab === undefined) throw new Error(`Unknown browser tab: ${tabId}`)
    this.activeTabId = tab.id
    this.openState = true
    this.visibleState = true
    this.showActiveTab()
    this.emit()
    return this.getState()
  }

  closeTab(tabId: string): BrowserState {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return this.getState()
    const [tab] = this.tabs.splice(index, 1)
    if (tab !== undefined) this.destroyTab(tab)
    if (this.tabs.length === 0) {
      this.activeTabId = undefined
      this.openState = false
      this.visibleState = false
    } else if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]
      this.activeTabId = next?.id
      this.visibleState = this.openState
    }
    this.showActiveTab()
    this.emit()
    return this.getState()
  }

  back(): BrowserState {
    const tab = this.activeTab()
    if (tab?.view.webContents.navigationHistory.canGoBack() === true) {
      tab.view.webContents.navigationHistory.goBack()
    }
    return this.getState()
  }

  forward(): BrowserState {
    const tab = this.activeTab()
    if (tab?.view.webContents.navigationHistory.canGoForward() === true) {
      tab.view.webContents.navigationHistory.goForward()
    }
    return this.getState()
  }

  reload(): BrowserState {
    this.activeTab()?.view.webContents.reload()
    return this.getState()
  }

  async loadUrl(url: string): Promise<BrowserState> {
    const tab = this.ensureTab()
    this.openState = true
    this.visibleState = true
    this.attachTab(tab)
    this.showActiveTab()
    const normalized = normalizeBrowserUrl(url)
    tab.url = normalized
    tab.loading = true
    this.error = undefined
    this.emit()
    await tab.view.webContents.loadURL(normalized)
    tab.loading = false
    tab.url = tab.view.webContents.getURL() || normalized
    tab.title = tab.view.webContents.getTitle() || tab.title
    this.emit()
    return this.getState()
  }

  async newTabAndLoad(url: string): Promise<BrowserState> {
    this.newTab()
    return this.loadUrl(url)
  }

  async observe(options: { textLimit: number; maxElements: number }): Promise<PageSnapshot> {
    this.requireOpen()
    return this.executePageFunction(collectPageSnapshot, options)
  }

  async readText(maxChars: number): Promise<ReturnType<typeof readPageText>> {
    this.requireOpen()
    return this.executePageFunction(readPageText, maxChars)
  }

  async performActions(actions: PageAction[]): Promise<{ performed: number; url: string; title: string }> {
    this.requireOpen()
    const result = await this.executePageFunction(performPageActions, actions)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await this.waitForIdle(5_000)
    const tab = this.activeTab()
    if (tab !== undefined) {
      tab.url = tab.view.webContents.getURL() || tab.url
      tab.title = tab.view.webContents.getTitle() || tab.title
      this.emit()
    }
    return result
  }

  async capturePng(): Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }> {
    this.requireOpen()
    const tab = this.requireActiveTab()
    const image = await tab.view.webContents.capturePage()
    if (image.isEmpty()) throw new Error('Browser screen capture is empty')
    const size = image.getSize()
    return {
      data: image.toPNG().toString('base64'),
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
    }
  }

  setBounds(bounds: BrowserBounds): void {
    const content = this.window.getContentBounds()
    const x = clamp(Math.round(bounds.x), 0, content.width)
    const y = clamp(Math.round(bounds.y), 0, content.height)
    const width = clamp(Math.round(bounds.width), 0, content.width - x)
    const height = clamp(Math.round(bounds.height), 0, content.height - y)
    this.lastBounds = { x, y, width, height }
    this.activeTab()?.view.setBounds(this.lastBounds)
  }

  async capture(): Promise<string | undefined> {
    const tab = this.activeTab()
    if (tab === undefined || tab.view.webContents.isDestroyed()) return undefined
    const image = await tab.view.webContents.capturePage()
    if (image.isEmpty()) return undefined
    const size = image.getSize()
    const resized = size.width > 640 ? image.resize({ width: 640, quality: 'good' }) : image
    return resized.toDataURL()
  }

  dispose(): void {
    for (const tab of this.tabs.splice(0)) this.destroyTab(tab)
    this.activeTabId = undefined
    this.openState = false
    this.visibleState = false
  }

  private createTab(url: string): BrowserTab {
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    const tab: BrowserTab = {
      id: randomUUID(),
      view,
      attached: false,
      url,
      title: '',
      loading: false,
    }
    this.tabs.push(tab)
    this.attachTab(tab)
    this.installTabEvents(tab)
    if (url !== 'about:blank') {
      tab.loading = true
      void view.webContents.loadURL(url).catch((error: unknown) => {
        tab.loading = false
        this.error = error instanceof Error ? error.message : String(error)
        this.emit()
      })
    }
    return tab
  }

  private installTabEvents(tab: BrowserTab): void {
    const view = tab.view
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    view.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    view.webContents.on('did-start-loading', () => {
      tab.loading = true
      this.emit()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.loading = false
      tab.url = view.webContents.getURL() || tab.url
      tab.title = view.webContents.getTitle() || tab.title
      this.emit()
    })
    view.webContents.on('did-navigate', (_event, url) => {
      tab.url = url
      this.emit()
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      tab.url = url
      this.emit()
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title
      this.emit()
    })
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.loading = false
      this.error = errorDescription
      this.emit()
    })
    view.webContents.on('destroyed', () => {
      const index = this.tabs.findIndex((candidate) => candidate.id === tab.id)
      if (index >= 0) this.tabs.splice(index, 1)
      if (this.activeTabId === tab.id) this.activeTabId = this.tabs[0]?.id
      this.emit()
    })
  }

  private ensureTab(): BrowserTab {
    const active = this.activeTab()
    if (active !== undefined) return active
    const tab = this.createTab('about:blank')
    this.activeTabId = tab.id
    return tab
  }

  private activeTab(): BrowserTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId)
  }

  private requireActiveTab(): BrowserTab {
    const tab = this.activeTab()
    if (tab === undefined || tab.view.webContents.isDestroyed()) throw new Error('Browser tab is unavailable')
    return tab
  }

  private attachTab(tab: BrowserTab): void {
    if (tab.attached) return
    this.window.contentView.addChildView(tab.view)
    tab.attached = true
    if (this.lastBounds !== undefined) tab.view.setBounds(this.lastBounds)
  }

  private showActiveTab(): void {
    for (const tab of this.tabs) {
      tab.view.setVisible(this.openState && this.visibleState && tab.id === this.activeTabId)
    }
    const tab = this.activeTab()
    if (tab !== undefined && this.lastBounds !== undefined) tab.view.setBounds(this.lastBounds)
  }

  private destroyTab(tab: BrowserTab): void {
    try {
      this.window.contentView.removeChildView(tab.view)
    } catch {
      // The window may already be gone.
    }
    tab.attached = false
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  }

  private async executePageFunction<Arg, Result>(fn: (arg: Arg) => Result, arg: Arg): Promise<Awaited<Result>> {
    const tab = this.requireActiveTab()
    const code = `(${fn.toString()})(${JSON.stringify(arg)})`
    return tab.view.webContents.executeJavaScript(code, true) as Promise<Awaited<Result>>
  }

  private async waitForIdle(timeoutMs: number): Promise<void> {
    const tab = this.activeTab()
    if (tab?.loading !== true) return
    const webContents = tab.view.webContents
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout
      const finish = (): void => {
        clearTimeout(timer)
        webContents.removeListener('did-stop-loading', finish)
        webContents.removeListener('did-fail-load', finish)
        resolve()
      }
      timer = setTimeout(finish, timeoutMs)
      webContents.once('did-stop-loading', finish)
      webContents.once('did-fail-load', finish)
    })
  }

  private requireOpen(): void {
    if (!this.openState) throw new Error('Browser is not open. Use browser_open first.')
    this.requireActiveTab()
  }

  private emit(): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    const event: BrowserLiveEvent = { type: 'state', state: this.getState() }
    this.window.webContents.send('browser:event', event)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
