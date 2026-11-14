export type CustomProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

export type ModelInput = 'text' | 'image'

export const REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffort = typeof REASONING_EFFORTS[number]

/** Resolve a saved effort against the capabilities of one concrete model. */
export function resolveReasoningEffort(
  preferred: ReasoningEffort | undefined,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supported.length === 0) return undefined
  if (preferred !== undefined && supported.includes(preferred)) return preferred
  const mediumIndex = REASONING_EFFORTS.indexOf('medium')
  for (let index = mediumIndex; index < REASONING_EFFORTS.length; index += 1) {
    const candidate = REASONING_EFFORTS[index]
    if (candidate !== undefined && supported.includes(candidate)) return candidate
  }
  for (let index = mediumIndex - 1; index >= 0; index -= 1) {
    const candidate = REASONING_EFFORTS[index]
    if (candidate !== undefined && supported.includes(candidate)) return candidate
  }
  return supported[0]
}

export interface ModelDescriptor {
  id: string
  name: string
  providerId: string
  api: string
  reasoning: boolean
  reasoningEfforts: ReasoningEffort[]
  contextWindow: number
  maxTokens: number
  input: ModelInput[]
}

export interface ModelProviderSummary {
  id: string
  name: string
  baseUrl?: string
  kind: 'builtin' | 'custom'
  configured: boolean
  authSource?: string
  modelCount: number
}

export interface ModelSelection {
  providerId: string
  modelId: string
}

export interface CustomModelConfig {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  reasoningEfforts: ReasoningEffort[]
  input: ModelInput[]
}

export interface CustomProviderConfig {
  id: string
  name: string
  baseUrl: string
  api: CustomProviderApi
  models: CustomModelConfig[]
}

export interface ModelSettings {
  version: 1
  defaultModel?: ModelSelection | undefined
  defaultReasoningEffort?: ReasoningEffort | undefined
  customProviders: CustomProviderConfig[]
}

export interface ModelConfigSnapshot {
  providers: ModelProviderSummary[]
  defaultModel?: ModelSelection | undefined
  defaultReasoningEffort?: ReasoningEffort | undefined
  modelSettingsVersion: 1
}

export interface SaveCredentialInput {
  providerId: string
  apiKey: string
}

export interface SetDefaultModelInput {
  providerId: string
  modelId: string
  reasoningEffort?: ReasoningEffort | undefined
}

export interface DeleteCustomProviderInput {
  providerId: string
}

export interface ModelTestInput {
  providerId: string
  modelId: string
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  text?: string
  error?: string
}

export interface ModelBridge {
  getSnapshot(): Promise<ModelConfigSnapshot>
  getConfiguredModels(): Promise<ModelDescriptor[]>
  getModels(providerId: string): Promise<ModelDescriptor[]>
  saveCredential(input: SaveCredentialInput): Promise<ModelConfigSnapshot>
  deleteCredential(providerId: string): Promise<ModelConfigSnapshot>
  setDefault(input: SetDefaultModelInput): Promise<ModelConfigSnapshot>
  saveCustomProvider(input: CustomProviderConfig): Promise<ModelConfigSnapshot>
  deleteCustomProvider(input: DeleteCustomProviderInput): Promise<ModelConfigSnapshot>
  testModel(input: ModelTestInput): Promise<ModelTestResult>
}


export type TaskStatus = 'proposed' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type TaskOrigin = 'user' | 'automation'
export type TaskWaitingReason = 'input' | 'approval'

/** Durable user-facing work, independent of any one Session used to execute it. */
export interface Task {
  id: string
  title: string
  status: TaskStatus
  origin: TaskOrigin
  sessionId?: string
  approvalId?: string
  prompt?: string
  waitingReason?: TaskWaitingReason
  detail?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export interface CreateTaskInput {
  title: string
  origin: TaskOrigin
  status?: 'proposed' | 'queued'
  sessionId?: string
  prompt?: string
}

export interface TaskStatusUpdate {
  status: TaskStatus
  waitingReason?: TaskWaitingReason
  detail?: string
}

export type TaskLiveEvent = {
  type: 'task.updated'
  task: Task
}

export interface TaskBridge {
  list(): Promise<Task[]>
  get(taskId: string): Promise<Task>
  create(input: CreateTaskInput): Promise<Task>
  updateStatus(taskId: string, update: TaskStatusUpdate): Promise<Task>
  updatePrompt(taskId: string, prompt: string): Promise<Task>
  assignSession(taskId: string, sessionId: string | null): Promise<Task>
  onEvent(listener: (event: TaskLiveEvent) => void): () => void
}

export type LocalSourceKind = 'file-watch' | 'schedule'
export type AutomationMode = 'observe' | 'active'

export interface AutomationSettings {
  mode: AutomationMode
  maxPendingSuggestions: number
  suggestionCooldownMinutes: number
}

export interface FileWatchSourceConfig {
  kind: 'file-watch'
  path: string
  recursive: boolean
  maxDepth: number
}

export interface ScheduleSourceConfig {
  kind: 'schedule'
  intervalMinutes: number
  title: string
  prompt: string
}

export type LocalSourceConfig = FileWatchSourceConfig | ScheduleSourceConfig

export interface LocalSource {
  id: string
  name: string
  enabled: boolean
  config: LocalSourceConfig
  lastError?: string
  createdAt: string
  updatedAt: string
}

export type CreateLocalSourceInput =
  | { name: string; config: FileWatchSourceConfig }
  | { name: string; config: ScheduleSourceConfig }

export interface LocalSourceBridge {
  getAutomationSettings(): Promise<AutomationSettings>
  setAutomationSettings(settings: AutomationSettings): Promise<AutomationSettings>
  list(): Promise<LocalSource[]>
  create(input: CreateLocalSourceInput): Promise<LocalSource>
  setEnabled(sourceId: string, enabled: boolean): Promise<LocalSource>
  remove(sourceId: string): Promise<void>
  chooseDirectory(): Promise<string | undefined>
  pollNow(): Promise<void>
}

export type PermissionKind = 'local-read' | 'workspace-write' | 'external-write' | 'destructive'
export type PermissionMode = 'allow' | 'ask' | 'deny'
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface PermissionPolicy {
  localRead: PermissionMode
  workspaceWrite: PermissionMode
  externalWrite: PermissionMode
  destructive: PermissionMode
}

export interface PermissionRequestInput {
  kind: PermissionKind
  title: string
  summary: string
  details?: string
  taskId?: string
}

export interface ApprovalRequest {
  id: string
  kind: PermissionKind
  title: string
  summary: string
  details?: string
  taskId?: string
  status: ApprovalStatus
  createdAt: string
  resolvedAt?: string
}

export type PermissionOutcome =
  | { decision: 'allowed' }
  | { decision: 'denied'; reason: string }
  | { decision: 'approval_required'; approval: ApprovalRequest }

export interface PermissionBridge {
  getPolicy(): Promise<PermissionPolicy>
  setPolicy(policy: PermissionPolicy): Promise<PermissionPolicy>
  request(input: PermissionRequestInput): Promise<PermissionOutcome>
}

export interface ApprovalBridge {
  listPending(): Promise<ApprovalRequest[]>
  get(approvalId: string): Promise<ApprovalRequest>
  resolve(approvalId: string, decision: 'approved' | 'denied'): Promise<ApprovalRequest>
}

export interface SessionSummary {
  id: string
  title: string
  status: 'idle' | 'running' | 'failed'
  createdAt: string
  updatedAt: string
}

export interface SessionTimelineEvent {
  sessionId: string
  seq: number
  eventId: string
  type: string
  data: unknown
  actor: {
    kind: 'user' | 'agent' | 'system'
    id: string
  }
  createdAt: string
}

export type SessionLiveEvent =
  | {
      type: 'assistant.delta'
      sessionId: string
      runId: string
      delta: string
    }
  | {
      type: 'assistant.thinking'
      sessionId: string
      runId: string
      delta: string
    }
  | {
      type: 'tool.started'
      sessionId: string
      runId: string
      toolCallId: string
      toolName: string
      arguments: string
    }
  | {
      type: 'tool.finished'
      sessionId: string
      runId: string
      toolCallId: string
      toolName: string
      isError: boolean
    }
  | {
      type: 'run.status'
      sessionId: string
      runId: string
      status: 'running' | 'idle' | 'failed' | 'cancelled'
      error?: string
    }
  | {
      type: 'context.updated'
      sessionId: string
      runId: string
      tokens: number
      budget: number
      compacted: boolean
    }
  | {
      type: 'session.updated'
      session: SessionSummary
    }

export interface SessionPromptInput {
  sessionId: string
  text: string
  attachments?: AttachmentDescriptor[] | undefined
}

export interface AttachmentDescriptor {
  name: string
  path: string
  size: number
}

export interface SessionBridge {
  list(): Promise<SessionSummary[]>
  create(sessionId?: string): Promise<SessionSummary>
  getEvents(sessionId: string): Promise<SessionTimelineEvent[]>
  prompt(input: SessionPromptInput): Promise<SessionSummary>
  cancel(sessionId: string): Promise<void>
  attach(sessionId: string): Promise<AttachmentDescriptor[]>
  onEvent(listener: (event: SessionLiveEvent) => void): () => void
}

export interface RuntimeCapabilities {
  platform: NodeJS.Platform
  shell: {
    available: boolean
    backend: string
    reason?: string
  }
}

export interface ThemeState {
  shouldUseDarkColors: boolean
}

export interface LifecycleBridge {
  onShowTasks(listener: () => void): () => void
}

export interface ThemeBridge {
  getState(): Promise<ThemeState>
  onChange(listener: (state: ThemeState) => void): () => void
}

export type NativeLocale = 'en' | 'zh-CN'

export interface I18nBridge {
  getNativeLocale(): Promise<NativeLocale>
}

export interface BarnBridge {
  platform: NodeJS.Platform
  getCapabilities(): Promise<RuntimeCapabilities>
  theme: ThemeBridge
  i18n: I18nBridge
  models: ModelBridge
  sessions: SessionBridge
  tasks: TaskBridge
  permissions: PermissionBridge
  approvals: ApprovalBridge
  localSources: LocalSourceBridge
  lifecycle: LifecycleBridge
}
