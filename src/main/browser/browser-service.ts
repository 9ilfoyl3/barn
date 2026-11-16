import { BrowserWindow, session, WebContentsView } from 'electron'
import type { BrowserBounds, BrowserLiveEvent, BrowserState } from '../../shared/models'
import { isAllowedBrowserUrl, normalizeBrowserUrl } from './browser-policy'
import { collectPageSnapshot, performPageActions, readPageText, type PageAction, type PageSnapshot } from './page-script'

const browserPartition = 'persist:barn-agent-browser'

export class BrowserService {
  private readonly browserSession = session.fromPartition(browserPartition)
  private view: WebContentsView | undefined
  private attached = false
  private lastBounds: BrowserBounds | undefined
  private state: BrowserState = {
    open: false,
    visible: false,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }

  constructor(private readonly window: BrowserWindow) {
    this.browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    this.browserSession.setPermissionCheckHandler(() => false)
  }

  getState(): BrowserState {
    return { ...this.state }
  }

  open(url?: string): BrowserState {
    const view = this.ensureView()
    this.attachView(view)
    view.setVisible(true)
    this.patch({ open: true, visible: true })
    if (url !== undefined) return this.navigate(url)
    return this.getState()
  }

  close(): BrowserState {
    this.view?.setVisible(false)
    this.patch({ open: false, visible: false })
    return this.getState()
  }

  navigate(url: string): BrowserState {
    const view = this.ensureView()
    this.attachView(view)
    view.setVisible(true)
    const normalized = normalizeBrowserUrl(url)
    this.patch({ open: true, visible: true, url: normalized, loading: true, error: undefined })
    void view.webContents.loadURL(normalized).catch((error: unknown) => {
      this.patch({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return this.getState()
  }

  back(): BrowserState {
    if (this.view?.webContents.navigationHistory.canGoBack() === true) {
      this.view.webContents.navigationHistory.goBack()
      this.syncNavigationState()
    }
    return this.getState()
  }

  forward(): BrowserState {
    if (this.view?.webContents.navigationHistory.canGoForward() === true) {
      this.view.webContents.navigationHistory.goForward()
      this.syncNavigationState()
    }
    return this.getState()
  }

  reload(): BrowserState {
    this.view?.webContents.reload()
    return this.getState()
  }

  async loadUrl(url: string): Promise<BrowserState> {
    const view = this.ensureView()
    this.attachView(view)
    view.setVisible(true)
    const normalized = normalizeBrowserUrl(url)
    this.patch({ open: true, visible: true, url: normalized, loading: true, error: undefined })
    await view.webContents.loadURL(normalized)
    this.syncNavigationState()
    this.patch({ loading: false })
    return this.getState()
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
    await this.waitForIdle(5_000)
    this.syncNavigationState()
    return result
  }

  async capturePng(): Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }> {
    this.requireOpen()
    const view = this.ensureView()
    const image = await view.webContents.capturePage()
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
    this.view?.setBounds(this.lastBounds)
  }

  async capture(): Promise<string | undefined> {
    if (this.view === undefined || this.view.webContents.isDestroyed()) return undefined
    const image = await this.view.webContents.capturePage()
    if (image.isEmpty()) return undefined
    const size = image.getSize()
    const resized = size.width > 640 ? image.resize({ width: 640, quality: 'good' }) : image
    return resized.toDataURL()
  }

  dispose(): void {
    const view = this.view
    this.view = undefined
    this.attached = false
    if (view === undefined) return
    try {
      this.window.contentView.removeChildView(view)
    } catch {
      // The parent window may already be gone.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private async executePageFunction<Arg, Result>(fn: (arg: Arg) => Result, arg: Arg): Promise<Awaited<Result>> {
    const view = this.ensureView()
    const code = `(${fn.toString()})(${JSON.stringify(arg)})`
    return view.webContents.executeJavaScript(code, true) as Promise<Awaited<Result>>
  }

  private async waitForIdle(timeoutMs: number): Promise<void> {
    if (this.state.loading !== true || this.view === undefined) return
    const webContents = this.view.webContents
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
    if (!this.state.open || this.view === undefined || this.view.webContents.isDestroyed()) {
      throw new Error('Browser is not open. Use browser_open first.')
    }
  }

  private ensureView(): WebContentsView {
    if (this.view !== undefined && !this.view.webContents.isDestroyed()) return this.view
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
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    view.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    view.webContents.on('did-start-loading', () => this.patch({ loading: true, error: undefined }))
    view.webContents.on('did-stop-loading', () => {
      this.syncNavigationState()
      this.patch({ loading: false })
    })
    view.webContents.on('did-navigate', (_event, url) => {
      this.patch({ url })
      this.syncNavigationState()
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      this.patch({ url })
      this.syncNavigationState()
    })
    view.webContents.on('page-title-updated', (_event, title) => this.patch({ title }))
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.patch({ loading: false, error: errorDescription })
    })
    view.webContents.on('destroyed', () => {
      if (this.view === view) this.view = undefined
      this.attached = false
    })
    this.view = view
    const fallbackWidth = Math.max(420, Math.round(this.window.getContentBounds().width * 0.52))
    this.lastBounds ??= {
      x: Math.max(0, this.window.getContentBounds().width - fallbackWidth),
      y: 104,
      width: fallbackWidth,
      height: Math.max(0, this.window.getContentBounds().height - 104),
    }
    view.setBounds(this.lastBounds)
    return view
  }

  private attachView(view: WebContentsView): void {
    if (this.attached) return
    this.window.contentView.addChildView(view)
    this.attached = true
    if (this.lastBounds !== undefined) view.setBounds(this.lastBounds)
  }

  private syncNavigationState(): void {
    const webContents = this.view?.webContents
    if (webContents === undefined || webContents.isDestroyed()) return
    this.patch({
      url: webContents.getURL() || this.state.url,
      title: webContents.getTitle() || this.state.title,
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
    })
  }

  private patch(patch: Partial<BrowserState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
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
