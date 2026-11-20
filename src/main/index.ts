import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, powerMonitor, shell, type IpcMainInvokeEvent } from 'electron'
import { registerModelIpc } from './ipc'
import { ModelService } from './models/model-service'
import { registerRuntimeIpc } from './platform/runtime-ipc'
import { ShellService } from './sandbox/shell-service'
import { loadOrCreateDeviceDataKey } from './session/device-data-key'
import { AesGcmEventCipher } from './session/event-cipher'
import { registerSessionIpc } from './session/session-ipc'
import { ThreadService } from './threads/thread-service'
import { registerThreadIpc } from './threads/thread-ipc'
import { registerDelegationIpc } from './delegation/delegation-ipc'
import { ActionService } from './actions/action-service'
import { registerDiagnosticsIpc } from './diagnostics/diagnostics-ipc'
import { DiagnosticsService } from './diagnostics/diagnostics-service'
import { MemoryService } from './memory/memory-service'
import { MemoryExtractionService } from './memory/memory-extraction'
import { registerMemoryIpc } from './memory/memory-ipc'
import { registerPermissionIpc } from './permissions/permission-ipc'
import { registerLocalSourceIpc } from './sources/local-source-ipc'
import { LocalSourceService } from './sources/local-source-service'
import { PermissionService } from './permissions/permission-service'
import { TaskConversationService } from './tasks/task-conversation-service'
import { registerTaskIpc } from './tasks/task-ipc'
import { registerRouterIpc } from './router/router-ipc'
import { RouterService } from './router/router-service'
import { ModelRouterDecisionEngine } from './router/router-decision'
import { TaskRunner } from './tasks/task-runner'
import { TaskService } from './tasks/task-service'
import { SessionStore } from './session/session-store'
import { scrubbedShellEnvironment } from './sandbox/environment'
import { ToolService } from './tools/tool-service'
import { AgentService } from './worker/agent-service'
import { createElectronWorkerTransport } from './worker/electron-worker-transport'
import { WorkerSupervisor } from './worker/worker-supervisor'
import { nativeLocale } from './platform/native-locale'
import { getRuntimeCapabilities } from './platform/runtime-capabilities'
import { AlwaysOnLifecycle } from './lifecycle/always-on-lifecycle'
import { BrowserService } from './browser/browser-service'
import { registerBrowserIpc } from './browser/browser-ipc'
import { BrowserToolService, type BrowserToolContext } from './browser/browser-tools'
import { BrowserSessionStore } from './browser/browser-session-store'
import { TerminalService } from './terminal/terminal-service'
import { registerTerminalIpc } from './terminal/terminal-ipc'

if (process.env.BARN_USER_DATA_DIR !== undefined) {
  app.setPath('userData', process.env.BARN_USER_DATA_DIR)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | undefined
let modelService: ModelService | undefined
let sessionStore: SessionStore | undefined
let agentService: AgentService | undefined
let taskService: TaskService | undefined
let taskConversationService: TaskConversationService | undefined
let taskRunner: TaskRunner | undefined
let routerService: RouterService | undefined
let permissionService: PermissionService | undefined
let actionService: ActionService | undefined
let localSourceService: LocalSourceService | undefined
let lifecycle: AlwaysOnLifecycle | undefined
let diagnosticsService: DiagnosticsService | undefined
let memoryExtractionService: MemoryExtractionService | undefined
let browserService: BrowserService | undefined
const taskBrowserServices = new Map<string, BrowserService>()
let terminalService: TerminalService | undefined
let maintenanceTimer: NodeJS.Timeout | undefined
let isQuitting = false
const shellService = new ShellService()

function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#181817' : '#fbfbfa'
}

async function createWindow(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 21 },
        }
      : {}),
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = window
  browserService = new BrowserService(
    window,
    new BrowserSessionStore(join(app.getPath('userData'), 'browser-session.json')),
  )
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    browserService?.dispose()
    browserService = undefined
    for (const browser of taskBrowserServices.values()) browser.dispose()
    taskBrowserServices.clear()
    if (mainWindow === window) mainWindow = undefined
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const allowed = devUrl !== undefined && url.startsWith(devUrl)
    if (!allowed) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) void createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function showTasks(): void {
  showWindow()
  const send = (): void => mainWindow?.webContents.send('runtime:show-tasks')
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send)
  else send()
}

function resumeWork(): void {
  taskRunner?.kick()
  void memoryExtractionService?.runOnce().catch(() => undefined)
  void localSourceService?.pollNow()
  void actionService?.runDue()
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return url.startsWith('file://')
    || (devUrl !== undefined && url.startsWith(devUrl))
}

function getTaskBrowser(context: BrowserToolContext): BrowserService | undefined {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return undefined
  const key = context.sessionId ?? 'unscoped'
  const existing = taskBrowserServices.get(key)
  if (existing !== undefined) return existing
  const browser = new BrowserService(mainWindow, undefined, {
    partition: `barn-task-browser:${key}`,
    publishEvents: false,
  })
  taskBrowserServices.set(key, browser)
  return browser
}

void app.whenReady().then(async () => {
  nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(windowBackgroundColor()))
  const userData = app.getPath('userData')
  modelService = new ModelService(app.getPath('userData'))
  await modelService.initialize()
  const deviceKey = await loadOrCreateDeviceDataKey(join(userData, 'sessions', 'device-key.bin'))
  const deviceCipher = new AesGcmEventCipher(deviceKey)
  sessionStore = new SessionStore(
    join(userData, 'sessions', 'sessions.db'),
    deviceCipher,
  )
  await sessionStore.initialize()
  sessionStore.recoverInterruptedSessions()
  sessionStore.tasks.recoverInterruptedTasks()
  const workspaceRoot = join(userData, 'workspace')
  const outputRoot = join(userData, 'output')
  const privateTempRoot = join(userData, 'sandbox-temp')
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
    mkdir(outputRoot, { recursive: true, mode: 0o700 }),
    mkdir(privateTempRoot, { recursive: true, mode: 0o700 }),
  ])
  const memoryService = new MemoryService(sessionStore.memories)
  const threadService = new ThreadService(sessionStore.threads)
  terminalService = new TerminalService(outputRoot, privateTempRoot)
  const browserTools = new BrowserToolService({
    getBrowser: getTaskBrowser,
    workspaceRoot,
    outputRoot,
    privateTempRoot,
    getPermissions: () => permissionService,
  })
  const tools = new ToolService({
    workspaceRoot,
    outputRoot,
    privateTempRoot,
    shell: shellService,
    memory: memoryService,
    browser: browserTools,
  })
  const supervisor = new WorkerSupervisor({
    createTransport: () => createElectronWorkerTransport(
      join(__dirname, 'worker.js'),
      scrubbedShellEnvironment(process.env, privateTempRoot),
    ),
  })
  agentService = new AgentService(supervisor, modelService, sessionStore, tools, memoryService, threadService)
  await agentService.start()
  taskService = new TaskService(sessionStore.tasks)
  taskConversationService = new TaskConversationService(taskService, sessionStore)
  routerService = new RouterService(
    sessionStore.router,
    threadService,
    sessionStore,
    taskService,
    new ModelRouterDecisionEngine(modelService, memoryService),
  )
  taskRunner = new TaskRunner(agentService, taskService, sessionStore, {
    routerRequestIdForTask: (taskId) => routerService?.getSnapshot().requests.findLast((request) => request.taskId === taskId)?.id,
  }, threadService)
  taskRunner.start()
  routerService.start()
  permissionService = new PermissionService(sessionStore.permissions, taskService)
  actionService = new ActionService(sessionStore.actions, permissionService)
  actionService.start()
  localSourceService = new LocalSourceService(sessionStore.localSources, taskService)
  localSourceService.start()
  registerModelIpc(modelService, trustedSender)
  registerMemoryIpc(memoryService, trustedSender)
  registerSessionIpc(sessionStore, agentService, join(workspaceRoot, 'attachments'), trustedSender, () => nativeLocale())
  registerThreadIpc(threadService, trustedSender)
  registerDelegationIpc(trustedSender)
  registerTaskIpc(taskService, taskConversationService, trustedSender)
  registerRouterIpc(routerService, trustedSender)
  registerPermissionIpc(permissionService, trustedSender)
  registerLocalSourceIpc(localSourceService, trustedSender)
  diagnosticsService = new DiagnosticsService(
    sessionStore,
    localSourceService,
    userData,
    () => getRuntimeCapabilities(shellService),
    () => browserService,
  )
  registerDiagnosticsIpc(diagnosticsService, trustedSender)
  memoryExtractionService = new MemoryExtractionService(sessionStore, modelService, {
    threads: threadService,
    isRouterIdle: () => {
      const snapshot = routerService?.getSnapshot()
      return snapshot !== undefined && snapshot.queuedCount === 0 && snapshot.activeRequest === undefined
    },
  })
  memoryExtractionService.start()
  sessionStore.runRetention()
  maintenanceTimer = setInterval(() => sessionStore?.runRetention(), 24 * 60 * 60 * 1_000)
  maintenanceTimer.unref()
  registerRuntimeIpc(shellService, trustedSender, () => nativeLocale())
  registerBrowserIpc(() => browserService, trustedSender)
  registerTerminalIpc(terminalService, trustedSender)
  await createWindow()
  lifecycle = new AlwaysOnLifecycle({
    showWindow,
    showTasks,
    resumeWork,
    quit: () => {
      isQuitting = true
      app.quit()
    },
  }, taskService)
  lifecycle.install()
  powerMonitor.on('resume', resumeWork)
  powerMonitor.on('unlock-screen', resumeWork)

  app.on('activate', showWindow)
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Barn failed to start: ${message}`)
  dialog.showErrorBox('Barn could not start', message)
  app.quit()
})

// Barn stays resident for background Tasks. Quit is explicit from the tray or app menu.
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  isQuitting = true
  lifecycle?.dispose()
  lifecycle = undefined
  taskRunner?.stop()
  taskRunner = undefined
  routerService?.stop()
  routerService = undefined
  taskService = undefined
  permissionService = undefined
  actionService?.stop()
  actionService = undefined
  localSourceService?.stop()
  localSourceService = undefined
  diagnosticsService = undefined
  memoryExtractionService?.stop()
  memoryExtractionService = undefined
  browserService?.dispose()
  browserService = undefined
  for (const browser of taskBrowserServices.values()) browser.dispose()
  taskBrowserServices.clear()
  terminalService?.disposeAll()
  terminalService = undefined
  if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer)
  maintenanceTimer = undefined
  void agentService?.stop()
  agentService = undefined
  sessionStore?.close()
  sessionStore = undefined
})

app.on('second-instance', showWindow)
