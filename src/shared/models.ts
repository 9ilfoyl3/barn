export type CustomProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

export type ModelInput = 'text' | 'image'

export interface ModelDescriptor {
  id: string
  name: string
  providerId: string
  api: string
  reasoning: boolean
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
  customProviders: CustomProviderConfig[]
}

export interface ModelConfigSnapshot {
  providers: ModelProviderSummary[]
  defaultModel?: ModelSelection | undefined
  modelSettingsVersion: 1
}

export interface SaveCredentialInput {
  providerId: string
  apiKey: string
}

export interface SetDefaultModelInput {
  providerId: string
  modelId: string
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
  getModels(providerId: string): Promise<ModelDescriptor[]>
  saveCredential(input: SaveCredentialInput): Promise<ModelConfigSnapshot>
  deleteCredential(providerId: string): Promise<ModelConfigSnapshot>
  setDefault(input: SetDefaultModelInput): Promise<ModelConfigSnapshot>
  saveCustomProvider(input: CustomProviderConfig): Promise<ModelConfigSnapshot>
  deleteCustomProvider(input: DeleteCustomProviderInput): Promise<ModelConfigSnapshot>
  testModel(input: ModelTestInput): Promise<ModelTestResult>
}


export type EmployeeFieldSource = 'document' | 'user' | 'inferred'

export interface EmployeeFieldValue {
  value: string
  source: EmployeeFieldSource
  confidence?: number | undefined
  evidence?: string[] | undefined
}

export interface EmployeeIntakeIssue {
  code: string
  message: string
  field?: string | undefined
}

export interface EmployeeIntakeEmployee {
  id: string
  fields: Record<string, EmployeeFieldValue>
  sourceFiles: string[]
  status: 'ready' | 'blocked'
  issues: EmployeeIntakeIssue[]
}

export interface EmployeeIntake {
  id: string
  sessionId: string
  revision: number
  status: 'draft' | 'ready' | 'blocked' | 'committed'
  employees: EmployeeIntakeEmployee[]
  createdAt: string
  updatedAt: string
  committedEmployeeIds?: string[] | undefined
  committedAt?: string | undefined
}

export interface EmployeeIntakePreviewRow {
  employeeId: string
  employeeNo?: string
  displayName?: string
  status: 'ready' | 'blocked'
  errors: EmployeeIntakeIssue[]
}

export interface EmployeeIntakePreview {
  previewId: string
  previewHash: string
  expiresAt: string
  summary: {
    total: number
    ready: number
    blocked: number
  }
  rows: EmployeeIntakePreviewRow[]
}

export interface EmployeeIntakeCommitResult {
  employees: Array<{
    id: string
    employeeNo: string
    displayName: string
    workEmail?: string | undefined
  }>
  committedAt: string
}

export type EmployeeLifecycleStatus =
  | 'preboarding'
  | 'onboarding'
  | 'probation'
  | 'active'
  | 'offboarding'
  | 'terminated'

export interface EmployeeOrgUnit {
  id: string
  code: string
  name: string
  parentId?: string | undefined
}

export interface EmployeeManager {
  id: string
  employeeNo: string
  displayName: string
}

export interface EmployeeSummary {
  id: string
  employeeNo?: string | undefined
  displayName?: string | undefined
  workEmail?: string | undefined
  status?: EmployeeLifecycleStatus | undefined
  hireDate?: string | undefined
  orgUnit?: EmployeeOrgUnit | undefined
  jobTitle?: string | undefined
  location?: string | undefined
  manager?: EmployeeManager | undefined
}

export interface EmployeeEmployment {
  id: string
  employmentType: string
  hireDate?: string | undefined
  probationEndDate?: string | undefined
  contractEndDate?: string | undefined
  terminationDate?: string | undefined
  lifecycleStatus: EmployeeLifecycleStatus
  effectiveFrom: string
  effectiveTo?: string | undefined
  version: number
}

export interface EmployeeAssignment {
  id: string
  orgUnit?: EmployeeOrgUnit | undefined
  manager?: EmployeeManager | undefined
  jobTitle?: string | undefined
  location?: string | undefined
  effectiveFrom: string
  effectiveTo?: string | undefined
  version: number
}

export interface EmployeeDetail extends EmployeeSummary {
  version: number
  createdAt: string
  updatedAt: string
  employment?: EmployeeEmployment | undefined
  assignment?: EmployeeAssignment | undefined
  maskedFields: Record<string, string>
  sensitiveRefs: Record<string, string>
  cache?: HrReadMetadata | undefined
}

export type LifecycleProposalStatus = 'pending_approval' | 'approved' | 'rejected' | 'committed' | 'blocked'

export interface LifecycleProposal {
  id: string
  employeeId: string
  employeeNo: string
  displayName: string
  fromStatus: EmployeeLifecycleStatus
  toStatus: EmployeeLifecycleStatus
  effectiveDate: string
  reason: string
  employeeVersion: number
  status: LifecycleProposalStatus
  proposedAt: string
  decidedAt?: string | undefined
  committedAt?: string | undefined
}

export interface EmployeeLifecycleState {
  employeeId: string
  employeeNo: string
  displayName: string
  status: EmployeeLifecycleStatus
  version: number
  allowedTransitions: EmployeeLifecycleStatus[]
  pendingProposal?: LifecycleProposal | undefined
  recentProposals: LifecycleProposal[]
  cache?: HrReadMetadata | undefined
}

export interface LifecycleProposalRequest {
  toStatus: EmployeeLifecycleStatus
  effectiveDate: string
  reason: string
}

export interface LifecycleDecisionInput {
  decision: 'approve' | 'reject'
  idempotencyKey: string
}

export interface LifecycleDecisionResult {
  proposal: LifecycleProposal
  employee: {
    id: string
    status: EmployeeLifecycleStatus
    version: number
  }
}

export type LifecycleCaseStatus =
  | 'pending_approval'
  | 'scheduled'
  | 'completed'
  | 'rejected'
  | 'blocked'

export interface LifecycleTask {
  id: string
  title: string
  description?: string | undefined
  status: 'pending' | 'completed' | 'blocked'
  assigneeUserId?: string | undefined
  assigneeRole?: string | undefined
  required: boolean
  dueAt?: string | undefined
  completedAt?: string | undefined
  updatedAt?: string | undefined
}

export interface LifecycleTaskTemplate {
  id: string
  fromStatus: EmployeeLifecycleStatus
  toStatus: EmployeeLifecycleStatus
  title: string
  description?: string | undefined
  assigneeRole: string
  dueOffsetDays: number
  required: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface LifecycleTaskTemplateInput {
  fromStatus: EmployeeLifecycleStatus
  toStatus: EmployeeLifecycleStatus
  title: string
  description?: string | undefined
  assigneeRole?: string | undefined
  dueOffsetDays?: number | undefined
  required?: boolean | undefined
}

export interface LifecycleTaskTemplateUpdateInput {
  title?: string | undefined
  description?: string | null | undefined
  assigneeRole?: string | undefined
  dueOffsetDays?: number | undefined
  required?: boolean | undefined
  enabled?: boolean | undefined
}

export interface LifecycleTaskUpdateInput {
  title?: string | undefined
  status?: 'pending' | 'completed' | 'blocked' | undefined
  assigneeUserId?: string | null | undefined
  dueAt?: string | null | undefined
}

export interface LifecycleCaseSummary {
  id: string
  employeeId: string
  employeeNo: string
  displayName: string
  caseType: string
  status: LifecycleCaseStatus
  currentStage?: EmployeeLifecycleStatus | undefined
  openedAt: string
  closedAt?: string | undefined
  transition?: LifecycleProposal | undefined
  tasks: LifecycleTask[]
}

export interface LifecycleCaseSearchInput {
  status?: LifecycleCaseStatus | undefined
  employeeId?: string | undefined
  page?: number | undefined
  pageSize?: number | undefined
}

export interface HrNotification {
  id: string
  type: string
  title: string
  body: string
  payload: Record<string, unknown>
  readAt?: string | undefined
  createdAt: string
}

export interface LifecycleCaseSearchResult {
  cases: LifecycleCaseSummary[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNextPage: boolean
  cache?: HrReadMetadata | undefined
}

export interface EmployeeSearchInput {
  q?: string | undefined
  status?: EmployeeLifecycleStatus | undefined
  orgUnitId?: string | undefined
  orgUnitCode?: string | undefined
  page?: number | undefined
  pageSize?: number | undefined
  fields?: string | undefined
}

export interface HrReadMetadata {
  source: 'network' | 'cache'
  cachedAt: string
  expiresAt: string
}

export interface EmployeeSearchResult {
  employees: EmployeeSummary[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNextPage: boolean
  cache?: HrReadMetadata | undefined
}

export interface OrgUnitDetail extends EmployeeOrgUnit {
  effectiveFrom: string
  effectiveTo?: string | undefined
  cache?: HrReadMetadata | undefined
}

export interface HrBridge {
  searchEmployees(input?: EmployeeSearchInput): Promise<EmployeeSearchResult>
  getEmployee(employeeId: string): Promise<EmployeeDetail>
  getOrgUnit(idOrCode: string): Promise<OrgUnitDetail>
  getLifecycle(employeeId: string): Promise<EmployeeLifecycleState>
  proposeLifecycleTransition(employeeId: string, input: LifecycleProposalRequest): Promise<LifecycleProposal>
  decideLifecycleProposal(proposalId: string, input: LifecycleDecisionInput): Promise<LifecycleDecisionResult>
  listLifecycleCases(input?: LifecycleCaseSearchInput): Promise<LifecycleCaseSearchResult>
  getLifecycleCase(caseId: string): Promise<LifecycleCaseSummary>
  listLifecycleTaskTemplates(): Promise<LifecycleTaskTemplate[]>
  createLifecycleTaskTemplate(input: LifecycleTaskTemplateInput): Promise<LifecycleTaskTemplate>
  updateLifecycleTaskTemplate(templateId: string, input: LifecycleTaskTemplateUpdateInput): Promise<LifecycleTaskTemplate>
  updateLifecycleTask(caseId: string, taskId: string, input: LifecycleTaskUpdateInput): Promise<LifecycleTask>
  listNotifications(unreadOnly?: boolean): Promise<HrNotification[]>
  markNotificationRead(notificationId: string): Promise<HrNotification>
  listEmployees(): Promise<EmployeeIntakeCommitResult['employees']>
}

export interface UpdateEmployeeIntakeInput {
  sessionId: string
  employeeId: string
  fields: Record<string, string>
  expectedRevision: number
}

export interface CommitEmployeeIntakeInput {
  sessionId: string
  previewId: string
  previewHash: string
  employeeIds: string[]
}


export interface AuthUser {
  id: string
  email: string
  name: string
  tenantId: string
  tenantName: string
  deviceId: string
  roles: string[]
  permissions: string[]
}

export interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  user?: AuthUser | undefined
  error?: string | undefined
}

export interface AuthBridge {
  getState(): Promise<AuthState>
  login(): Promise<AuthState>
  logout(): Promise<AuthState>
  onStateChanged(listener: (state: AuthState) => void): () => void
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
  | {
      type: 'intake.updated'
      sessionId: string
      intake: EmployeeIntake
    }
  | {
      type: 'lifecycle.proposal'
      sessionId: string
      proposal: LifecycleProposal
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
  getIntake(sessionId: string): Promise<EmployeeIntake | undefined>
  updateIntakeEmployee(input: UpdateEmployeeIntakeInput): Promise<EmployeeIntake>
  previewIntake(sessionId: string): Promise<EmployeeIntakePreview>
  commitIntake(input: CommitEmployeeIntakeInput): Promise<EmployeeIntakeCommitResult>
  listEmployees(): Promise<EmployeeIntakeCommitResult['employees']>
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

export interface BarnBridge {
  platform: NodeJS.Platform
  getCapabilities(): Promise<RuntimeCapabilities>
  models: ModelBridge
  sessions: SessionBridge
  auth: AuthBridge
  hr: HrBridge
}
