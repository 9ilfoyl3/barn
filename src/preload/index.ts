import { contextBridge, ipcRenderer } from 'electron'
import type {
  BarnBridge,
  CustomProviderConfig,
  DeleteCustomProviderInput,
  AttachmentDescriptor,
  I18nBridge,
  ModelBridge,
  ModelTestInput,
  RuntimeCapabilities,
  SaveCredentialInput,
  SessionBridge,
  SessionLiveEvent,
  NativeLocale,
  SessionPromptInput,
  TaskBridge,
  CreateTaskInput,
  TaskStatusUpdate,
  TaskLiveEvent,
  ApprovalBridge,
  PermissionBridge,
  PermissionPolicy,
  PermissionRequestInput,
  ThemeBridge,
  ThemeState,
  SetDefaultModelInput,
} from '../shared/models'

const models: ModelBridge = {
  getSnapshot: () => ipcRenderer.invoke('models:get-snapshot'),
  getConfiguredModels: () => ipcRenderer.invoke('models:get-configured-models'),
  getModels: (providerId: string) => ipcRenderer.invoke('models:get-models', providerId),
  saveCredential: (input: SaveCredentialInput) => ipcRenderer.invoke('models:save-credential', input),
  deleteCredential: (providerId: string) => ipcRenderer.invoke('models:delete-credential', providerId),
  setDefault: (input: SetDefaultModelInput) => ipcRenderer.invoke('models:set-default', input),
  saveCustomProvider: (input: CustomProviderConfig) => ipcRenderer.invoke('models:save-custom-provider', input),
  deleteCustomProvider: (input: DeleteCustomProviderInput) => ipcRenderer.invoke('models:delete-custom-provider', input.providerId),
  testModel: (input: ModelTestInput) => ipcRenderer.invoke('models:test', input),
}

const sessions: SessionBridge = {
  list: () => ipcRenderer.invoke('sessions:list'),
  create: (sessionId?: string) => ipcRenderer.invoke('sessions:create', sessionId),
  getEvents: (sessionId: string) => ipcRenderer.invoke('sessions:get-events', sessionId),
  prompt: (input: SessionPromptInput) => ipcRenderer.invoke('sessions:prompt', input),
  cancel: (sessionId: string) => ipcRenderer.invoke('sessions:cancel', sessionId),
  attach: (sessionId: string) => ipcRenderer.invoke('sessions:attach', sessionId) as Promise<AttachmentDescriptor[]>,
  onEvent: (listener: (event: SessionLiveEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, liveEvent: SessionLiveEvent): void => listener(liveEvent)
    ipcRenderer.on('sessions:event', handler)
    return () => ipcRenderer.removeListener('sessions:event', handler)
  },
}

const tasks: TaskBridge = {
  list: () => ipcRenderer.invoke('tasks:list'),
  get: (taskId: string) => ipcRenderer.invoke('tasks:get', taskId),
  create: (input: CreateTaskInput) => ipcRenderer.invoke('tasks:create', input),
  updateStatus: (taskId: string, update: TaskStatusUpdate) => ipcRenderer.invoke('tasks:update-status', { taskId, update }),
  updatePrompt: (taskId: string, prompt: string) => ipcRenderer.invoke('tasks:update-prompt', { taskId, prompt }),
  assignSession: (taskId: string, sessionId: string | null) => ipcRenderer.invoke('tasks:assign-session', { taskId, sessionId }),
  onEvent: (listener: (event: TaskLiveEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, liveEvent: TaskLiveEvent): void => listener(liveEvent)
    ipcRenderer.on('tasks:event', handler)
    return () => ipcRenderer.removeListener('tasks:event', handler)
  },
}

const permissions: PermissionBridge = {
  getPolicy: () => ipcRenderer.invoke('permissions:get-policy'),
  setPolicy: (policy: PermissionPolicy) => ipcRenderer.invoke('permissions:set-policy', policy),
  request: (input: PermissionRequestInput) => ipcRenderer.invoke('permissions:request', input),
}

const approvals: ApprovalBridge = {
  listPending: () => ipcRenderer.invoke('approvals:list-pending'),
  get: (approvalId: string) => ipcRenderer.invoke('approvals:get', approvalId),
  resolve: (approvalId: string, decision: 'approved' | 'denied') => ipcRenderer.invoke('approvals:resolve', { approvalId, decision }),
}

const theme: ThemeBridge = {
  getState: () => ipcRenderer.invoke('runtime:theme-state') as Promise<ThemeState>,
  onChange: (listener: (state: ThemeState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ThemeState): void => listener(state)
    ipcRenderer.on('runtime:theme-changed', handler)
    return () => ipcRenderer.removeListener('runtime:theme-changed', handler)
  },
}

const i18n: I18nBridge = {
  getNativeLocale: () => ipcRenderer.invoke('runtime:native-locale') as Promise<NativeLocale>,
}

const api: BarnBridge = {
  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke('runtime:capabilities') as Promise<RuntimeCapabilities>,
  theme,
  i18n,
  models,
  sessions,
  tasks,
  permissions,
  approvals,
}
contextBridge.exposeInMainWorld('barn', api)
