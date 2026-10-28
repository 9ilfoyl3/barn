import { contextBridge, ipcRenderer } from 'electron'
import type {
  BarnBridge,
  CustomProviderConfig,
  DeleteCustomProviderInput,
  AttachmentDescriptor,
  AuthBridge,
  AuthState,
  CommitEmployeeIntakeInput,
  EmployeeIntake,
  EmployeeIntakeCommitResult,
  EmployeeIntakePreview,
  EmployeeSearchInput,
  HrBridge,
  LifecycleCaseSearchInput,
  LifecycleDecisionInput,
  LifecycleTaskTemplateInput,
  LifecycleTaskTemplateUpdateInput,
  LifecycleTaskUpdateInput,
  LifecycleProposalRequest,
  ModelBridge,
  ModelTestInput,
  RuntimeCapabilities,
  SaveCredentialInput,
  SessionBridge,
  SessionLiveEvent,
  SessionPromptInput,
  SetDefaultModelInput,
  UpdateEmployeeIntakeInput,
} from '../shared/models'

const models: ModelBridge = {
  getSnapshot: () => ipcRenderer.invoke('models:get-snapshot'),
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
  getIntake: (sessionId: string) => ipcRenderer.invoke('intake:get', sessionId) as Promise<EmployeeIntake | undefined>,
  updateIntakeEmployee: (input: UpdateEmployeeIntakeInput) => ipcRenderer.invoke('intake:update-employee', input) as Promise<EmployeeIntake>,
  previewIntake: (sessionId: string) => ipcRenderer.invoke('intake:preview', sessionId) as Promise<EmployeeIntakePreview>,
  commitIntake: (input: CommitEmployeeIntakeInput) => ipcRenderer.invoke('intake:commit', input) as Promise<EmployeeIntakeCommitResult>,
  listEmployees: () => ipcRenderer.invoke('intake:list-employees') as Promise<EmployeeIntakeCommitResult['employees']>,
  onEvent: (listener: (event: SessionLiveEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, liveEvent: SessionLiveEvent): void => listener(liveEvent)
    ipcRenderer.on('sessions:event', handler)
    return () => ipcRenderer.removeListener('sessions:event', handler)
  },
}

const auth: AuthBridge = {
  getState: () => ipcRenderer.invoke('auth:get-state') as Promise<AuthState>,
  login: () => ipcRenderer.invoke('auth:login') as Promise<AuthState>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<AuthState>,
  onStateChanged: (listener: (state: AuthState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AuthState): void => listener(state)
    ipcRenderer.on('auth:state-changed', handler)
    return () => ipcRenderer.removeListener('auth:state-changed', handler)
  },
}

const hr: HrBridge = {
  searchEmployees: (input?: EmployeeSearchInput) => ipcRenderer.invoke('hr:search-employees', input),
  getEmployee: (employeeId: string) => ipcRenderer.invoke('hr:get-employee', employeeId),
  getOrgUnit: (idOrCode: string) => ipcRenderer.invoke('hr:get-org-unit', idOrCode),
  getLifecycle: (employeeId: string) => ipcRenderer.invoke('hr:get-lifecycle', employeeId),
  proposeLifecycleTransition: (employeeId: string, input: LifecycleProposalRequest) => ipcRenderer.invoke('hr:propose-lifecycle-transition', employeeId, input),
  decideLifecycleProposal: (proposalId: string, input: LifecycleDecisionInput) => ipcRenderer.invoke('hr:decide-lifecycle-proposal', proposalId, input),
  listLifecycleCases: (input?: LifecycleCaseSearchInput) => ipcRenderer.invoke('hr:list-lifecycle-cases', input),
  getLifecycleCase: (caseId: string) => ipcRenderer.invoke('hr:get-lifecycle-case', caseId),
  listLifecycleTaskTemplates: () => ipcRenderer.invoke('hr:list-lifecycle-task-templates'),
  createLifecycleTaskTemplate: (input: LifecycleTaskTemplateInput) => ipcRenderer.invoke('hr:create-lifecycle-task-template', input),
  updateLifecycleTaskTemplate: (templateId: string, input: LifecycleTaskTemplateUpdateInput) => ipcRenderer.invoke('hr:update-lifecycle-task-template', templateId, input),
  updateLifecycleTask: (caseId: string, taskId: string, input: LifecycleTaskUpdateInput) => ipcRenderer.invoke('hr:update-lifecycle-task', caseId, taskId, input),
  listNotifications: (unreadOnly?: boolean) => ipcRenderer.invoke('hr:list-notifications', unreadOnly ?? false),
  markNotificationRead: (notificationId: string) => ipcRenderer.invoke('hr:mark-notification-read', notificationId),
  listEmployees: () => ipcRenderer.invoke('hr:list-employees'),
}

const api: BarnBridge = {

  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke('runtime:capabilities') as Promise<RuntimeCapabilities>,
  models,
  sessions,
  auth,
  hr,
}
contextBridge.exposeInMainWorld('barn', api)
