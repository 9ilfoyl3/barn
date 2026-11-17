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

export type VisibleMessageRole = 'user' | 'assistant' | 'system'

/** The single user-visible Assistant history. Session IDs never define this identity. */
export interface PrincipalThread {
  id: string
  lastVisibleSeq: number
  createdAt: string
  updatedAt: string
}

export interface VisibleMessage {
  id: string
  threadId: string
  seq: number
  role: VisibleMessageRole
  content: unknown
  metadata: Record<string, unknown>
  sourceRefs: string[]
  clientMessageId?: string
  createdAt: string
}

export interface AppendVisibleMessageInput {
  clientMessageId?: string
  role: VisibleMessageRole
  content: unknown
  metadata?: Record<string, unknown>
  sourceRefs?: string[]
}

export interface PrincipalThreadSnapshot {
  thread: PrincipalThread
  messages: VisibleMessage[]
}

export type ThreadLiveEvent = {
  type: 'thread.message-appended'
  message: VisibleMessage
}

export interface ThreadBridge {
  getSnapshot(): Promise<PrincipalThreadSnapshot>
  listMessages(options?: { afterSeq?: number; limit?: number }): Promise<VisibleMessage[]>
  appendMessage(input: AppendVisibleMessageInput): Promise<VisibleMessage>
  onEvent(listener: (event: ThreadLiveEvent) => void): () => void
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

export type MemoryScope = 'global' | 'workspace'
export type MemoryKind = 'preference' | 'fact' | 'procedure' | 'decision' | 'project'

export interface MemoryEntry {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  title: string
  content: string
  tags: string[]
  pinned: boolean
  confidence: number
  sourceSessionIds: string[]
  version: number
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  useCount: number
}

export interface MemorySettings {
  enabled: boolean
  useMemories: boolean
  generateMemories: boolean
  idleMinutes: number
  maxEntries: number
}

export interface MemorySessionControls {
  useMemories: boolean
  generateMemories: boolean
}

export interface MemoryExtractionCandidate {
  sessionId: string
  workingDirectory?: string
  lastSeq: number
  updatedAt: string
}

export interface MemoryExtractionState {
  sessionId: string
  lastProcessedSeq: number
  lastProcessedAt?: string
  lastError?: string
  attempts: number
  nextAttemptAt?: string
}

export interface MemorySaveInput {
  kind: MemoryKind
  scope: MemoryScope
  workspacePath?: string
  title: string
  content: string
  tags?: string[]
  key?: string
  pinned?: boolean
  confidence?: number
  sourceSessionId?: string
}

export interface MemoryBridge {
  getSettings(): Promise<MemorySettings>
  setSettings(settings: Partial<MemorySettings>): Promise<MemorySettings>
  list(): Promise<MemoryEntry[]>
  delete(id: string): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<MemoryEntry>
  getSessionControls(sessionId: string): Promise<MemorySessionControls>
  setSessionControls(sessionId: string, controls: Partial<MemorySessionControls>): Promise<MemorySessionControls>
}

export interface TerminalCreateInput {
  terminalId: string
  workingDirectory?: string | undefined
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  terminalId: string
  shell: string
  cwd: string
}

export interface TerminalDataEvent {
  terminalId: string
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number
  signal?: number | undefined
}

export interface TerminalBridge {
  create(input: TerminalCreateInput): Promise<TerminalSessionInfo>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  dispose(terminalId: string): Promise<void>
  onData(listener: (event: TerminalDataEvent) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}

export interface DiagnosticsSnapshot {
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  electronVersion: string
  nodeVersion: string
  schemaVersion: number
  stateDirectory: string
  retentionDays: number
  lastMaintenanceAt?: string
  counts: {
    sessions: number
    tasks: number
    approvalsPending: number
    actionsActive: number
    localSources: number
    memoryEntries: number
  }
  automationMode: 'observe' | 'active'
  browser: {
    open: boolean
    tabs: number
    downloads: number
  }
  agentComputer: {
    providers: AgentComputerProviderCapability[]
  }
  shell: {
    available: boolean
    backend: string
    reason?: string
  }
}

export interface DiagnosticsBridge {
  get(): Promise<DiagnosticsSnapshot>
  setRetentionDays(days: number): Promise<number>
  runMaintenance(): Promise<{ cutoff: string; actionEvents: number; sourceEvents: number; approvals: number }>
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
  onChange(listener: (approval: ApprovalRequest) => void): () => void
  get(approvalId: string): Promise<ApprovalRequest>
  resolve(approvalId: string, decision: 'approved' | 'denied'): Promise<ApprovalRequest>
}

export interface SessionSummary {
  id: string
  title: string
  status: 'idle' | 'running' | 'failed'
  hasUnreadResult: boolean
  pinned: boolean
  archivedAt?: string
  workingDirectory?: string
  parentSessionId?: string
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
  workingDirectory?: string | undefined
}

export interface AttachmentDescriptor {
  name: string
  path: string
  size: number
  kind?: 'file' | 'directory' | undefined
}

export type AttachmentPreview =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'text'; text: string; variant: 'plain' | 'pdf' | 'document' | 'presentation' | 'spreadsheet' }

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
  active: boolean
}

export interface BrowserHistoryEntry {
  url: string
  title: string
  visitedAt: string
}

export interface BrowserDownloadState {
  id: string
  filename: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
}

export interface BrowserState {
  open: boolean
  visible: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  activeTabId?: string | undefined
  tabs: BrowserTabState[]
  downloads: BrowserDownloadState[]
  history: BrowserHistoryEntry[]
  error?: string | undefined
}

export interface BrowserLiveEvent {
  type: 'state'
  state: BrowserState
}

export interface BrowserBridge {
  getState(): Promise<BrowserState>
  open(url?: string): Promise<BrowserState>
  close(): Promise<BrowserState>
  navigate(url: string): Promise<BrowserState>
  newTab(url?: string): Promise<BrowserState>
  activateTab(tabId: string): Promise<BrowserState>
  closeTab(tabId: string): Promise<BrowserState>
  revealDownload(downloadId: string): Promise<boolean>
  back(): Promise<BrowserState>
  forward(): Promise<BrowserState>
  reload(): Promise<BrowserState>
  setBounds(bounds: BrowserBounds): Promise<void>
  capture(): Promise<string | undefined>
  onEvent(listener: (event: BrowserLiveEvent) => void): () => void
}

export interface SessionBridge {
  list(): Promise<SessionSummary[]>
  create(sessionId?: string, parentSessionId?: string): Promise<SessionSummary>
  getEvents(sessionId: string): Promise<SessionTimelineEvent[]>
  prompt(input: SessionPromptInput): Promise<SessionSummary>
  cancel(sessionId: string): Promise<void>
  attach(sessionId: string): Promise<AttachmentDescriptor[]>
  chooseDirectory(): Promise<string | undefined>
  setWorkingDirectory(sessionId: string, workingDirectory: string): Promise<SessionSummary>
  clearWorkingDirectory(sessionId: string): Promise<SessionSummary>
  markRead(sessionId: string): Promise<SessionSummary>
  setPinned(sessionId: string, pinned: boolean): Promise<SessionSummary>
  setArchived(sessionId: string, archived: boolean): Promise<SessionSummary>
  getAttachmentPreview(path: string): Promise<AttachmentPreview | undefined>
  onEvent(listener: (event: SessionLiveEvent) => void): () => void
}

export interface AgentComputerProviderCapability {
  id: 'built-in-browser' | 'secure-vm' | 'host-computer'
  label: string
  kind: 'browser' | 'desktop'
  isolation: 'browser-session' | 'virtual-machine' | 'host-permissions'
  available: boolean
  reason?: string | undefined
}

export interface RuntimeCapabilities {
  platform: NodeJS.Platform
  shell: {
    available: boolean
    backend: string
    reason?: string
  }
  agentComputer: {
    defaultProvider: 'built-in-browser' | 'secure-vm' | 'host-computer'
    providers: AgentComputerProviderCapability[]
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
  browser: BrowserBridge
  terminal: TerminalBridge
  sessions: SessionBridge
  threads: ThreadBridge
  tasks: TaskBridge
  permissions: PermissionBridge
  approvals: ApprovalBridge
  localSources: LocalSourceBridge
  lifecycle: LifecycleBridge
  diagnostics: DiagnosticsBridge
  memory: MemoryBridge
}
