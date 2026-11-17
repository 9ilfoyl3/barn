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
  ThreadBridge,
  ThreadLiveEvent,
  DelegationBridge,
  DelegationInput,
  AppendVisibleMessageInput,
  TaskBridge,
  CreateTaskInput,
  TaskStatusUpdate,
  TaskLiveEvent,
  ApprovalBridge,
  PermissionBridge,
  PermissionPolicy,
  PermissionRequestInput,
  LocalSourceBridge,
  LifecycleBridge,
  DiagnosticsBridge,
  CreateLocalSourceInput,
  ThemeBridge,
  ThemeState,
  SetDefaultModelInput,
  MemoryBridge,
  ApprovalRequest,
  BrowserBridge,
  BrowserBounds,
  BrowserLiveEvent,
  TerminalBridge,
  TerminalCreateInput,
  TerminalDataEvent,
  TerminalExitEvent,
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

const browser: BrowserBridge = {
  getState: () => ipcRenderer.invoke('browser:get-state'),
  open: (url?: string) => ipcRenderer.invoke('browser:open', url),
  close: () => ipcRenderer.invoke('browser:close'),
  navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
  newTab: (url?: string) => ipcRenderer.invoke('browser:new-tab', url),
  activateTab: (tabId: string) => ipcRenderer.invoke('browser:activate-tab', tabId),
  closeTab: (tabId: string) => ipcRenderer.invoke('browser:close-tab', tabId),
  revealDownload: (downloadId: string) => ipcRenderer.invoke('browser:reveal-download', downloadId),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  setBounds: (bounds: BrowserBounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
  capture: () => ipcRenderer.invoke('browser:capture') as Promise<string | undefined>,
  onEvent: (listener: (event: BrowserLiveEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, liveEvent: BrowserLiveEvent): void => listener(liveEvent)
    ipcRenderer.on('browser:event', handler)
    return () => ipcRenderer.removeListener('browser:event', handler)
  },
}

const terminal: TerminalBridge = {
  create: (input: TerminalCreateInput) => ipcRenderer.invoke('terminal:create', input),
  write: (terminalId: string, data: string) => ipcRenderer.invoke('terminal:write', { terminalId, data }),
  resize: (terminalId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', { terminalId, cols, rows }),
  dispose: (terminalId: string) => ipcRenderer.invoke('terminal:dispose', terminalId),
  onData: (listener: (event: TerminalDataEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, dataEvent: TerminalDataEvent): void => listener(dataEvent)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onExit: (listener: (event: TerminalExitEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, exitEvent: TerminalExitEvent): void => listener(exitEvent)
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  },
}

const sessions: SessionBridge = {
  list: () => ipcRenderer.invoke('sessions:list'),
  create: (sessionId?: string, parentSessionId?: string) => ipcRenderer.invoke('sessions:create', sessionId, parentSessionId),
  getEvents: (sessionId: string) => ipcRenderer.invoke('sessions:get-events', sessionId),
  prompt: (input: SessionPromptInput) => ipcRenderer.invoke('sessions:prompt', input),
  cancel: (sessionId: string) => ipcRenderer.invoke('sessions:cancel', sessionId),
  attach: (sessionId: string) => ipcRenderer.invoke('sessions:attach', sessionId) as Promise<AttachmentDescriptor[]>,
  chooseDirectory: () => ipcRenderer.invoke('sessions:choose-directory') as Promise<string | undefined>,
  setWorkingDirectory: (sessionId: string, workingDirectory: string) => ipcRenderer.invoke('sessions:set-working-directory', { sessionId, workingDirectory }),
  clearWorkingDirectory: (sessionId: string) => ipcRenderer.invoke('sessions:clear-working-directory', sessionId),
  markRead: (sessionId: string) => ipcRenderer.invoke('sessions:mark-read', sessionId),
  setPinned: (sessionId: string, pinned: boolean) => ipcRenderer.invoke('sessions:set-pinned', { sessionId, pinned }),
  setArchived: (sessionId: string, archived: boolean) => ipcRenderer.invoke('sessions:set-archived', { sessionId, archived }),
  getAttachmentPreview: (path: string) => ipcRenderer.invoke('sessions:attachment-preview', path),
  onEvent: (listener: (event: SessionLiveEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, liveEvent: SessionLiveEvent): void => listener(liveEvent)
    ipcRenderer.on('sessions:event', handler)
    return () => ipcRenderer.removeListener('sessions:event', handler)
  },
}

const threads: ThreadBridge = {
  getSnapshot: () => ipcRenderer.invoke('threads:get-snapshot'),
  listMessages: (options?: { afterSeq?: number; limit?: number }) => ipcRenderer.invoke('threads:list-messages', options ?? {}),
  appendMessage: (input: AppendVisibleMessageInput) => ipcRenderer.invoke('threads:append-message', input),
  onEvent: (listener: (event: ThreadLiveEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, liveEvent: ThreadLiveEvent): void => listener(liveEvent)
    ipcRenderer.on('threads:event', handler)
    return () => ipcRenderer.removeListener('threads:event', handler)
  },
}

const delegation: DelegationBridge = {
  classify: (input: DelegationInput) => ipcRenderer.invoke('delegation:classify', input),
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
  onChange: (listener: (approval: ApprovalRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, approval: ApprovalRequest): void => listener(approval)
    ipcRenderer.on('approvals:event', handler)
    return () => ipcRenderer.removeListener('approvals:event', handler)
  },
  get: (approvalId: string) => ipcRenderer.invoke('approvals:get', approvalId),
  resolve: (approvalId: string, decision: 'approved' | 'denied') => ipcRenderer.invoke('approvals:resolve', { approvalId, decision }),
}

const localSources: LocalSourceBridge = {
  getAutomationSettings: () => ipcRenderer.invoke('local-sources:get-automation-settings'),
  setAutomationSettings: (settings) => ipcRenderer.invoke('local-sources:set-automation-settings', settings),
  list: () => ipcRenderer.invoke('local-sources:list'),
  create: (input: CreateLocalSourceInput) => ipcRenderer.invoke('local-sources:create', input),
  setEnabled: (sourceId: string, enabled: boolean) => ipcRenderer.invoke('local-sources:set-enabled', { sourceId, enabled }),
  remove: (sourceId: string) => ipcRenderer.invoke('local-sources:remove', sourceId),
  chooseDirectory: () => ipcRenderer.invoke('local-sources:choose-directory') as Promise<string | undefined>,
  pollNow: () => ipcRenderer.invoke('local-sources:poll-now'),
}

const lifecycle: LifecycleBridge = {
  onShowTasks: (listener: () => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('runtime:show-tasks', handler)
    return () => ipcRenderer.removeListener('runtime:show-tasks', handler)
  },
}

const memory: MemoryBridge = {
  getSettings: () => ipcRenderer.invoke('memory:get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('memory:set-settings', settings),
  list: () => ipcRenderer.invoke('memory:list'),
  listCandidates: () => ipcRenderer.invoke('memory:list-candidates'),
  confirm: (id: string) => ipcRenderer.invoke('memory:confirm', id),
  reject: (id: string) => ipcRenderer.invoke('memory:reject', id),
  delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
  setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('memory:set-pinned', { id, pinned }),
  getSessionControls: (sessionId: string) => ipcRenderer.invoke('memory:get-session-controls', sessionId),
  setSessionControls: (sessionId: string, controls) => ipcRenderer.invoke('memory:set-session-controls', { sessionId, controls }),
}

const diagnostics: DiagnosticsBridge = {
  get: () => ipcRenderer.invoke('diagnostics:get'),
  setRetentionDays: (days: number) => ipcRenderer.invoke('diagnostics:set-retention', days),
  runMaintenance: () => ipcRenderer.invoke('diagnostics:run-maintenance'),
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
  browser,
  terminal,
  sessions,
  threads,
  delegation,
  tasks,
  permissions,
  approvals,
  localSources,
  lifecycle,
  diagnostics,
  memory,
}
contextBridge.exposeInMainWorld('barn', api)
