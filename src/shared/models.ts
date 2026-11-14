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
}
