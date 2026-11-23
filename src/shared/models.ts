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

export type ConnectorFieldType = 'text' | 'password' | 'url' | 'number' | 'boolean'

export interface ConnectorSetupField {
  key: string
  label: string
  type: ConnectorFieldType
  required: boolean
  placeholder?: string
  defaultValue?: string | number | boolean
}

export interface ConnectorCapabilityDefinition {
  id: string
  name: string
  description: string
  risk: 'read' | 'external-write'
}

export interface ConnectorDefinition {
  kind: string
  name: string
  description: string
  icon: 'mail' | 'message-circle'
  configFields: ConnectorSetupField[]
  credentialFields: ConnectorSetupField[]
  capabilities: ConnectorCapabilityDefinition[]
  helpUrl?: string
  hideConnectionName?: boolean
}

export type ConnectorConfigValue = string | number | boolean
export type ConnectorConfig = Record<string, ConnectorConfigValue>

export type ConnectorStatus = 'ready' | 'needs_setup' | 'disabled' | 'error'

export interface ConnectorInstance {
  id: string
  kind: string
  name: string
  enabled: boolean
  configured: boolean
  status: ConnectorStatus
  config: ConnectorConfig
  capabilities: ConnectorCapabilityDefinition[]
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface CreateConnectorInput {
  kind: string
  name: string
  config: ConnectorConfig
}

export interface UpdateConnectorInput {
  name?: string
  config?: ConnectorConfig
  enabled?: boolean
}

export interface SaveConnectorCredentialsInput {
  connectorId: string
  values: Record<string, string>
  replace?: boolean
}

export interface ConnectorTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export interface ConnectorCallInput {
  connectorId: string
  capability: string
  arguments: Record<string, unknown>
}

export type ConnectorCallResult =
  | { kind: 'result'; value: unknown }
  | {
      kind: 'action'
      actionId: string
      status: 'pending_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown_effect'
      message: string
    }

export interface ConnectorActionSummary {
  id: string
  title: string
  summary: string
  details?: string
  status: 'pending_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown_effect'
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ConnectorBridge {
  listDefinitions(): Promise<ConnectorDefinition[]>
  list(): Promise<ConnectorInstance[]>
  create(input: CreateConnectorInput): Promise<ConnectorInstance>
  update(connectorId: string, input: UpdateConnectorInput): Promise<ConnectorInstance>
  remove(connectorId: string): Promise<void>
  saveCredentials(input: SaveConnectorCredentialsInput): Promise<ConnectorInstance>
  test(connectorId: string): Promise<ConnectorTestResult>
  call(input: ConnectorCallInput): Promise<ConnectorCallResult>
  listActions(): Promise<ConnectorActionSummary[]>
  retryAction(actionId: string): Promise<ConnectorActionSummary>
  cancelAction(actionId: string): Promise<ConnectorActionSummary>
}

export type VisibleMessageRole = 'user' | 'assistant' | 'system'

/** The single user-visible Assistant history. Session IDs never define this identity. */
export interface PrincipalThread {
  id: string
  lastVisibleSeq: number
  createdAt: string
  updatedAt: string
}

export type VisibleResultCardKind = 'file' | 'link' | 'task' | 'map'

export interface VisibleResultCardImage {
  dataUrl: string
  alt: string
}

/** Structured, allowlisted content that may accompany one assistant turn. */
export interface VisibleResultCard {
  version: 1
  kind: VisibleResultCardKind
  title: string
  description?: string
  provider?: string
  meta?: string
  status?: string
  href?: string
  image?: VisibleResultCardImage
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


export type RouterRequestStatus = 'queued' | 'routing' | 'completed' | 'failed' | 'cancelled'
export type RouterDecisionKind =
  | 'reply'
  | 'clarify'
  | 'create_task'
  | 'update_task'
  | 'cancel_task'
  | 'answer_task'

/** Durable admission of one user message into the serial Router lane. */
export interface RouterRequest {
  id: string
  threadId: string
  userMessageId: string
  sequence: number
  priority: number
  status: RouterRequestStatus
  attemptCount: number
  decisionKind?: RouterDecisionKind
  taskId?: string
  replyMessageId?: string
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export interface RouterSubmitInput {
  text: string
  clientMessageId?: string
  priority?: number
  attachments?: AttachmentDescriptor[]
  workingDirectory?: string
  locale?: 'en' | 'zh-CN'
}

export interface RouterSubmitResult {
  request: RouterRequest
  userMessage: VisibleMessage
}

export interface RouterSnapshot {
  requests: RouterRequest[]
  activeRequest?: RouterRequest
  queuedCount: number
}

export type RouterLiveEvent =
  | { type: 'router.request-updated'; request: RouterRequest }
  | { type: 'router.execution-started'; requestId: string; executionSessionId: string }
  | { type: 'router.execution-finished'; requestId: string }

export interface RouterBridge {
  submit(input: RouterSubmitInput): Promise<RouterSubmitResult>
  getSnapshot(): Promise<RouterSnapshot>
  cancel(requestId: string): Promise<RouterRequest>
  onEvent(listener: (event: RouterLiveEvent) => void): () => void
}

/** Host-only projection controls for a model execution. */
export interface AgentPromptOptions {
  projectUserMessage?: boolean
  /** Send the prompt to the model without appending a second user event to the Session. */
  recordUserMessage?: boolean
  /** Source identity recorded on the user-side Session event. Task launches record Router as the source. */
  userActorRole?: 'router' | 'worker'
  /** Source identity recorded on assistant Session events for this prompt. */
  assistantActorRole?: 'router' | 'worker'
  includeMemory?: boolean
  visibleMetadata?: Record<string, unknown>
  clientMessageIdPrefix?: string
  visibleActivity?: boolean
  projectAssistantMessage?: boolean
  toolPolicy?: 'default' | 'none'
}

export type DelegationAction = 'answer' | 'clarify' | 'task'
export type DelegationRisk = 'none' | 'local_write' | 'external_write' | 'destructive'

export interface TaskContract {
  objective: string
  deliverable: string
  constraints: string[]
  inputRefs: string[]
  sourceRefs: string[]
  acceptanceCriteria: string[]
  forbiddenActions: string[]
  risk: DelegationRisk
  deadline?: string
  executionLane: 'interactive' | 'background' | 'scheduled'
  expectedArtifacts: string[]
}

export interface DelegationInput {
  text: string
  attachmentNames?: string[]
  hasWorkingDirectory?: boolean
}

export interface DelegationDecision {
  action: DelegationAction
  confidence: number
  complexity: 'low' | 'medium' | 'high'
  risk: DelegationRisk
  requiredCapabilities: string[]
  missingInformation: string[]
  rationaleCodes: string[]
  taskContract?: TaskContract
}

export interface DelegationBridge {
  classify(input: DelegationInput): Promise<DelegationDecision>
}

export type TaskStatus = 'proposed' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type TaskOrigin = 'user' | 'automation'
export type TaskWaitingReason = 'input' | 'approval' | 'review'
export type TaskOutcome = 'completed' | 'needs_input' | 'needs_review' | 'failed' | 'cancelled'

export interface TaskResultEnvelope {
  outcome: TaskOutcome
  summary: string
  artifacts: string[]
  evidenceRefs: string[]
  limitations: string[]
  externalEffectReceipts: string[]
}
export type RoutineRecurrence = 'none' | 'daily' | 'weekdays' | 'weekly'

/** Durable user-facing work, independent of any one Session used to execute it. */
export interface Task {
  id: string
  title: string
  status: TaskStatus
  origin: TaskOrigin
  sessionId?: string
  approvalId?: string
  contract?: TaskContract
  result?: TaskResultEnvelope
  prompt?: string
  visiblePrompt?: string
  kind?: 'work' | 'reminder'
  scheduledFor?: string
  recurrence?: RoutineRecurrence
  timezone?: string
  workingDirectory?: string
  attachments?: AttachmentDescriptor[]
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
  contract?: TaskContract
  prompt?: string
  visiblePrompt?: string
  kind?: 'work' | 'reminder'
  scheduledFor?: string
  recurrence?: RoutineRecurrence
  timezone?: string
  workingDirectory?: string
  attachments?: AttachmentDescriptor[]
}

export interface TaskStatusUpdate {
  status: TaskStatus
  waitingReason?: TaskWaitingReason
  detail?: string
}

export interface UpdateRoutineInput {
  title: string
  text: string
  scheduledFor: string
  recurrence: RoutineRecurrence
  timezone: string
}

export type TaskLiveEvent = {
  type: 'task.updated'
  task: Task
}

export interface TaskContinuationResult {
  task: Task
  delivery: 'worker' | 'router'
  replyMessageId?: string
}

export interface TaskBridge {
  list(): Promise<Task[]>
  get(taskId: string): Promise<Task>
  create(input: CreateTaskInput): Promise<Task>
  updateStatus(taskId: string, update: TaskStatusUpdate): Promise<Task>
  updatePrompt(taskId: string, prompt: string): Promise<Task>
  assignSession(taskId: string, sessionId: string | null): Promise<Task>
  continueTask(taskId: string, text: string, attachments?: AttachmentDescriptor[]): Promise<TaskContinuationResult>
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
export type MemoryStatus = 'candidate' | 'active' | 'archived'
export type MemorySourceAuthority = 'explicit' | 'verified' | 'observed' | 'inferred'

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
  sourceRefs: string[]
  sourceAuthority: MemorySourceAuthority
  status: MemoryStatus
  version: number
  lastConfirmedAt?: string
  validUntil?: string
  supersedesId?: string
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
  sourceRefs?: string[]
  sourceAuthority?: MemorySourceAuthority
  status?: MemoryStatus
  validUntil?: string
}

export interface MemoryBridge {
  getSettings(): Promise<MemorySettings>
  setSettings(settings: Partial<MemorySettings>): Promise<MemorySettings>
  list(): Promise<MemoryEntry[]>
  delete(id: string): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<MemoryEntry>
  listCandidates(): Promise<MemoryEntry[]>
  confirm(id: string): Promise<MemoryEntry>
  reject(id: string): Promise<MemoryEntry>
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
    connectors: number
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

export type PermissionKind = 'local-read' | 'workspace-write' | 'external-read' | 'external-write' | 'destructive'
export type PermissionMode = 'allow' | 'ask' | 'deny'
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface PermissionPolicy {
  localRead: PermissionMode
  workspaceWrite: PermissionMode
  externalRead: PermissionMode
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
      actorRole?: 'router' | 'worker'
    }
  | {
      type: 'assistant.thinking'
      sessionId: string
      runId: string
      delta: string
      actorRole?: 'router' | 'worker'
    }
  | {
      type: 'tool.started'
      sessionId: string
      runId: string
      toolCallId: string
      toolName: string
      arguments: string
      actorRole?: 'router' | 'worker'
    }
  | {
      type: 'tool.finished'
      sessionId: string
      runId: string
      toolCallId: string
      toolName: string
      isError: boolean
      actorRole?: 'router' | 'worker'
    }
  | {
      type: 'run.status'
      sessionId: string
      runId: string
      status: 'running' | 'idle' | 'failed' | 'cancelled'
      error?: string
      actorRole?: 'router' | 'worker'
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
  router: RouterBridge
  delegation: DelegationBridge
  tasks: TaskBridge
  permissions: PermissionBridge
  approvals: ApprovalBridge
  localSources: LocalSourceBridge
  lifecycle: LifecycleBridge
  diagnostics: DiagnosticsBridge
  memory: MemoryBridge
  connectors: ConnectorBridge
}
