import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import { registerModelIpc } from './ipc'
import { ModelService } from './models/model-service'
import { ElectronSecretCodec } from './models/electron-secret-codec'
import { AuthService } from './auth/auth-service'
import { registerAuthIpc } from './auth/auth-ipc'
import { registerRuntimeIpc } from './platform/runtime-ipc'
import { ShellService } from './sandbox/shell-service'
import { loadOrCreateDeviceDataKey } from './session/device-data-key'
import { AesGcmEventCipher } from './session/event-cipher'
import { registerSessionIpc } from './session/session-ipc'
import { SessionStore } from './session/session-store'
import { scrubbedShellEnvironment } from './sandbox/environment'
import { ToolService } from './tools/tool-service'
import { EmployeeIntakeStore } from './intake/employee-intake-store'
import { HrClient } from './cloud/hr-client'
import { HrReadCache } from './cloud/hr-read-cache'
import { registerHrIpc } from './cloud/hr-ipc'
import { AgentService } from './worker/agent-service'
import { createElectronWorkerTransport } from './worker/electron-worker-transport'
import { WorkerSupervisor } from './worker/worker-supervisor'

if (process.env.BARN_USER_DATA_DIR !== undefined) {
  app.setPath('userData', process.env.BARN_USER_DATA_DIR)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | undefined
let modelService: ModelService | undefined
let sessionStore: SessionStore | undefined
let agentService: AgentService | undefined
let authService: AuthService | undefined
const shellService = new ShellService()

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 15 },
        }
      : {}),
    backgroundColor: '#111311',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
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

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return url.startsWith('file://')
    || (devUrl !== undefined && url.startsWith(devUrl))
}

void app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  modelService = new ModelService(app.getPath('userData'))
  await modelService.initialize()
  const deviceKey = await loadOrCreateDeviceDataKey(join(userData, 'sessions', 'device-key.bin'))
  const deviceCipher = new AesGcmEventCipher(deviceKey)
  const hrReadCache = new HrReadCache(
    join(userData, 'accounts'),
    deviceCipher,
    {
      ttlMs: Number.parseInt(process.env.BARN_HR_CACHE_TTL_MS ?? '300000', 10),
    },
  )
  authService = new AuthService({
    userDataDirectory: app.getPath('userData'),
    baseUrl: process.env.BARN_AUTH_BASE_URL ?? 'http://127.0.0.1:3100',
    clientId: process.env.BARN_AUTH_CLIENT_ID ?? 'barn-desktop',
    codec: new ElectronSecretCodec(),
    openExternal: (url) => shell.openExternal(url),
    onLogout: () => hrReadCache.clear(),
  })
  await authService.initialize()
  authService.onStateChanged((state) => {
    if (state.status === 'authenticated' && state.user !== undefined) {
      void hrReadCache.activate({ userId: state.user.id, tenantId: state.user.tenantId })
    } else if (state.status === 'unauthenticated') {
      void hrReadCache.clear()
    }
  })
  const initialAuthState = authService.getState()
  if (initialAuthState.status === 'authenticated' && initialAuthState.user !== undefined) {
    await hrReadCache.activate({ userId: initialAuthState.user.id, tenantId: initialAuthState.user.tenantId })
  }
  sessionStore = new SessionStore(
    join(userData, 'sessions', 'sessions.db'),
    deviceCipher,
  )
  await sessionStore.initialize()
  sessionStore.recoverInterruptedSessions()
  const workspaceRoot = join(userData, 'workspace')
  const outputRoot = join(userData, 'output')
  const privateTempRoot = join(userData, 'sandbox-temp')
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
    mkdir(outputRoot, { recursive: true, mode: 0o700 }),
    mkdir(privateTempRoot, { recursive: true, mode: 0o700 }),
  ])
  const intakeStore = new EmployeeIntakeStore(sessionStore)
  const hrClient = new HrClient(
    () => authService?.getAccessToken() ?? Promise.reject(new Error('Sign in required')),
    undefined,
    {
      cache: hrReadCache,
      getAuthScope: () => {
        const user = authService?.getState().user
        return user === undefined ? undefined : { userId: user.id, tenantId: user.tenantId }
      },
    },
  )
  const tools = new ToolService({
    workspaceRoot,
    outputRoot,
    privateTempRoot,
    shell: shellService,
    intake: intakeStore,
    hrClient,
  })
  const supervisor = new WorkerSupervisor({
    createTransport: () => createElectronWorkerTransport(
      join(__dirname, 'worker.js'),
      scrubbedShellEnvironment(process.env, privateTempRoot),
    ),
  })
  agentService = new AgentService(supervisor, modelService, sessionStore, tools, intakeStore, hrClient)
  await agentService.start()
  registerModelIpc(modelService, trustedSender)
  registerAuthIpc(authService, trustedSender)
  registerHrIpc(hrClient, trustedSender)
  registerSessionIpc(sessionStore, agentService, join(workspaceRoot, 'attachments'), trustedSender)
  registerRuntimeIpc(shellService, trustedSender)
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void agentService?.stop()
  agentService = undefined
  authService = undefined
  sessionStore?.close()
  sessionStore = undefined
})

app.on('second-instance', () => {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})
