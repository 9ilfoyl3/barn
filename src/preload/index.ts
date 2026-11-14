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
}
contextBridge.exposeInMainWorld('barn', api)
