import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { registerModelIpc } from './ipc'
import { ModelService } from './models/model-service'
import { registerRuntimeIpc } from './platform/runtime-ipc'
import { ShellService } from './sandbox/shell-service'
import { loadOrCreateDeviceDataKey } from './session/device-data-key'
import { AesGcmEventCipher } from './session/event-cipher'
import { registerSessionIpc } from './session/session-ipc'
import { ActionService } from './actions/action-service'
import { registerPermissionIpc } from './permissions/permission-ipc'
import { PermissionService } from './permissions/permission-service'
import { registerTaskIpc } from './tasks/task-ipc'
import { TaskRunner } from './tasks/task-runner'
import { TaskService } from './tasks/task-service'
import { SessionStore } from './session/session-store'
import { scrubbedShellEnvironment } from './sandbox/environment'
import { ToolService } from './tools/tool-service'
import { AgentService } from './worker/agent-service'
import { createElectronWorkerTransport } from './worker/electron-worker-transport'
import { WorkerSupervisor } from './worker/worker-supervisor'
import { nativeLocale } from './platform/native-locale'

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
let taskRunner: TaskRunner | undefined
let permissionService: PermissionService | undefined
let actionService: ActionService | undefined
const shellService = new ShellService()

function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#181817' : '#fbfbfa'
}

async function createWindow(): Promise<void> {
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
  const tools = new ToolService({
    workspaceRoot,
    outputRoot,
    privateTempRoot,
    shell: shellService,
  })
  const supervisor = new WorkerSupervisor({
    createTransport: () => createElectronWorkerTransport(
      join(__dirname, 'worker.js'),
      scrubbedShellEnvironment(process.env, privateTempRoot),
    ),
  })
  agentService = new AgentService(supervisor, modelService, sessionStore, tools)
  await agentService.start()
  taskService = new TaskService(sessionStore.tasks)
  taskRunner = new TaskRunner(agentService, taskService, sessionStore)
  taskRunner.start()
  permissionService = new PermissionService(sessionStore.permissions, taskService)
  actionService = new ActionService(sessionStore.actions, permissionService)
  actionService.start()
  registerModelIpc(modelService, trustedSender)
  registerSessionIpc(sessionStore, agentService, join(workspaceRoot, 'attachments'), trustedSender, () => nativeLocale())
  registerTaskIpc(taskService, trustedSender)
  registerPermissionIpc(permissionService, trustedSender)
  registerRuntimeIpc(shellService, trustedSender, () => nativeLocale())
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  taskRunner?.stop()
  taskRunner = undefined
  taskService = undefined
  permissionService = undefined
  actionService?.stop()
  actionService = undefined
  void agentService?.stop()
  agentService = undefined
  sessionStore?.close()
  sessionStore = undefined
})

app.on('second-instance', () => {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})
