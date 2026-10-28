import { randomUUID } from 'node:crypto'
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { ContextManager } from './context-manager'
import {
  parseHostToWorkerMessage,
  toolExecutionResultSchema,
  type HostToWorkerMessage,
  type ToolExecutionResult,
  type SessionUiEvent,
  type WorkerRequestInput,
  type WorkerSessionSeed,
  type WorkerToHostMessage,
} from '../shared/agent-protocol'

export interface WorkerPort {
  postMessage(message: WorkerToHostMessage): void
  onMessage(listener: (message: unknown) => void): () => void
}

interface PendingHostRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface ActiveModelStream {
  stream: AssistantMessageEventStream
  model: Model<Api>
}

const SYSTEM_PROMPT = `You are Barn, an HRBP desktop assistant.

You work inside a local workspace and can inspect files with tools. File types are unrestricted: use read_file for text, list_dir and search_files for discovery, shell for format-specific extraction or conversion, and view_image for supported images when the selected model accepts image input.

Never claim to have inspected a file unless a tool returned its content. Do not assume a file is CSV, XLSX, PDF, or a table; inspect it and adapt to its actual content.

For employee information, work incrementally across conversation turns. Prefer summaries and grouped exceptions over asking the user to manually repeat fields. Ask only for high-impact missing or ambiguous information. Never invent identity numbers, dates, salaries, or other sensitive employee facts.

When creating employee drafts, use employee_intake_create with normalized fields. Use the canonical keys employeeNo, displayName, workEmail, hireDate, orgUnit, orgUnitCode, jobTitle, location, and managerEmployeeNo where available. Include evidence for document-derived fields. Use employee_intake_update to apply user corrections. Use employee_intake_preview for Cloud validation. Never claim employees were created; final commit is a user action in the intake review panel.

For existing employee data, use employee_search, employee_get, org_unit_get, and employee_list_by_org. Treat returned HR data as read-only tenant-scoped context. Never use cached or previously returned employee data to authorize a write. If Cloud authentication is missing, tell the user to sign in.

Lifecycle changes are proposal-only. Use lifecycle_propose_transition to create a pending proposal with a reason and effective date. Never claim the lifecycle transition happened; the user must explicitly approve or reject it in Desktop.`

export class WorkerRuntime {
  private readonly sessions = new Map<string, WorkerSession>()
  private readonly pendingHostRequests = new Map<string, PendingHostRequest>()
  private readonly modelStreams = new Map<string, ActiveModelStream>()
  private shutdown = false

  constructor(private readonly port: WorkerPort) {
    port.onMessage((message) => this.handleMessage(message))
  }

  start(): void {
    this.port.postMessage({ type: 'worker.ready' })
  }

  private handleMessage(value: unknown): void {
    if (this.shutdown) return
    let message: HostToWorkerMessage
    try {
      message = parseHostToWorkerMessage(value)
    } catch (error) {
      this.port.postMessage({
        type: 'request.error',
        requestId: 'invalid-host-message',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    switch (message.type) {
      case 'worker.initialize':
        this.respondOk(message.requestId)
        return
      case 'session.open':
        this.openSession(message.requestId, message.session)
        return
      case 'session.prompt':
        this.prompt(message.requestId, message.sessionId, message.text)
        return
      case 'session.cancel':
        this.cancel(message.requestId, message.sessionId)
        return
      case 'request.ok':
        this.resolveHostRequest(message.requestId, message.result)
        return
      case 'request.error':
        this.rejectHostRequest(message.requestId, message.error)
        return
      case 'model.event':
        this.pushModelEvent(message.requestId, message.event)
        return
      case 'model.error': {
        const active = this.modelStreams.get(message.requestId)
        if (active !== undefined) {
          this.modelStreams.delete(message.requestId)
          active.stream.push({
            type: 'error',
            reason: 'error',
            error: errorMessage(active.model, message.error),
          })
        }
        return
      }
      case 'shutdown':
        this.stop()
        return
    }
  }

  private openSession(requestId: string, seed: WorkerSessionSeed): void {
    try {
      const existing = this.sessions.get(seed.sessionId)
      if (existing?.running === true) throw new Error('Session is already running')
      const session = new WorkerSession(
        seed,
        (toolName, args) => this.executeTool(seed.sessionId, toolName, args),
        (modelToUse, context, options) =>
          this.createModelStream(seed.sessionId, modelToUse, context, options),
        (runId, status, error) => this.port.postMessage({
          type: 'run.status',
          sessionId: seed.sessionId,
          runId,
          status,
          ...(error === undefined ? {} : { error }),
        }),
        (runId, event) => this.port.postMessage({
          type: 'session.event',
          sessionId: seed.sessionId,
          runId,
          event,
        }),
        (message) => this.appendMessage(seed.sessionId, message),
      )
      this.sessions.set(seed.sessionId, session)
      this.respondOk(requestId)
    } catch (error) {
      this.respondError(requestId, error)
    }
  }

  private prompt(requestId: string, sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      this.respondError(requestId, new Error(`Unknown session: ${sessionId}`))
      return
    }
    if (session.running) {
      this.respondError(requestId, new Error('Session is already running'))
      return
    }
    this.respondOk(requestId)
    void session.prompt(text)
  }

  private cancel(requestId: string, sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      this.respondError(requestId, new Error(`Unknown session: ${sessionId}`))
      return
    }
    session.cancel()
    this.respondOk(requestId)
  }

  private stop(): void {
    this.shutdown = true
    for (const session of this.sessions.values()) session.cancel()
    for (const active of this.modelStreams.values()) {
      active.stream.push({
        type: 'error',
        reason: 'aborted',
        error: errorMessage(active.model, 'Agent Worker stopped'),
      })
    }
    this.modelStreams.clear()
    for (const pending of this.pendingHostRequests.values()) {
      pending.reject(new Error('Agent Worker stopped'))
    }
    this.pendingHostRequests.clear()
  }

  private async executeTool(sessionId: string, toolName: string, args: unknown): Promise<ToolExecutionResult> {
    const result = await this.requestHost({
      type: 'tool.execute',
      sessionId,
      toolName,
      args,
    })
    return toolExecutionResultSchema.parse(result)
  }

  private createModelStream(
    sessionId: string,
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const requestId = `worker:model:${randomUUID()}`
    const stream = createAssistantMessageEventStream()
    this.modelStreams.set(requestId, { stream, model })

    const abort = (): void => {
      if (!this.modelStreams.has(requestId)) return
      this.modelStreams.delete(requestId)
      this.port.postMessage({ type: 'model.abort', requestId })
      stream.push({
        type: 'error',
        reason: 'aborted',
        error: errorMessage(model, 'Request aborted'),
      })
    }
    options?.signal?.addEventListener('abort', abort, { once: true })

    this.port.postMessage({
      type: 'model.start',
      requestId,
      sessionId,
      selection: { providerId: model.provider, modelId: model.id },
      context,
      options: serializableOptions(options),
    })
    return stream
  }

  private pushModelEvent(requestId: string, rawEvent: unknown): void {
    const active = this.modelStreams.get(requestId)
    if (active === undefined) return
    const event = rawEvent as AssistantMessageEvent
    active.stream.push(event)
    if (event.type === 'done' || event.type === 'error') {
      this.modelStreams.delete(requestId)
    }
  }

  private async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
    await this.requestHost({
      type: 'session.append',
      sessionId,
      message: stripImagePayloads(message),
    })
  }

  private requestHost(message: WorkerRequestInput): Promise<unknown> {
    const requestId = `worker:request:${randomUUID()}`
    return new Promise<unknown>((resolve, reject) => {
      this.pendingHostRequests.set(requestId, { resolve, reject })
      this.port.postMessage({ ...message, requestId } as WorkerToHostMessage)
    })
  }

  private resolveHostRequest(requestId: string, result: unknown): void {
    const pending = this.pendingHostRequests.get(requestId)
    if (pending === undefined) return
    this.pendingHostRequests.delete(requestId)
    pending.resolve(result)
  }

  private rejectHostRequest(requestId: string, error: string): void {
    const pending = this.pendingHostRequests.get(requestId)
    if (pending === undefined) return
    this.pendingHostRequests.delete(requestId)
    pending.reject(new Error(error))
  }

  private respondOk(requestId: string, result?: unknown): void {
    this.port.postMessage({
      type: 'request.ok',
      requestId,
      ...(result === undefined ? {} : { result }),
    })
  }

  private respondError(requestId: string, error: unknown): void {
    this.port.postMessage({
      type: 'request.error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

class WorkerSession {
  readonly agent: Agent
  private activeRunId: string | undefined
  private cancelled = false
  private promptPromise: Promise<void> | undefined

  constructor(
    private readonly seed: WorkerSessionSeed,
    executeTool: (toolName: string, args: unknown) => Promise<ToolExecutionResult>,
    createStream: (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream,
    reportStatus: (runId: string, status: 'running' | 'idle' | 'failed' | 'cancelled', error?: string) => void,
    reportEvent: (runId: string, event: SessionUiEvent) => void,
    appendMessage: (message: AgentMessage) => Promise<void>,
  ) {
    this.reportStatus = reportStatus
    this.reportEvent = reportEvent
    this.appendMessage = appendMessage
    const model = workerModel(seed.model)
    const contextManager = new ContextManager({
      contextWindow: seed.model.contextWindow,
      maxOutputTokens: seed.model.maxTokens,
    })
    this.agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        messages: seed.messages as AgentMessage[],
        model,
        tools: createTools(executeTool, seed.model.input.includes('image')),
      },
      convertToLlm: (messages) => messages.filter(isLlmMessage) as Message[],
      transformContext: async (messages) => {
        const result = contextManager.transform(messages)
        const runId = this.activeRunId
        if (runId !== undefined) {
          reportEvent(runId, {
            type: 'context.updated',
            tokens: result.tokens,
            budget: result.budget,
            compacted: result.compacted,
          })
        }
        return result.messages
      },
      streamFn: (modelToUse, context, options) =>
        createStream(modelToUse as Model<Api>, context, options),
    })

    this.agent.subscribe(async (event) => {
      const runId = this.activeRunId
      if (runId === undefined) return
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent
        if (delta.type === 'text_delta') {
          reportEvent(runId, { type: 'assistant.delta', delta: delta.delta })
        } else if (delta.type === 'thinking_delta') {
          reportEvent(runId, { type: 'assistant.thinking', delta: delta.delta })
        }
      } else if (event.type === 'message_end' && event.message.role !== 'user') {
        await appendMessage(event.message)
      } else if (event.type === 'tool_execution_start') {
        reportEvent(runId, {
          type: 'tool.started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: serializedToolArguments(event.args),
        })
      } else if (event.type === 'tool_execution_end') {
        reportEvent(runId, {
          type: 'tool.finished',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        })
      }
    })
  }

  private readonly reportStatus: (
    runId: string,
    status: 'running' | 'idle' | 'failed' | 'cancelled',
    error?: string,
  ) => void
  private readonly reportEvent: (runId: string, event: SessionUiEvent) => void
  private readonly appendMessage: (message: AgentMessage) => Promise<void>

  get running(): boolean {
    return this.activeRunId !== undefined
  }

  async prompt(text: string): Promise<void> {
    if (this.activeRunId !== undefined) throw new Error('Session is already running')
    const runId = `run:${randomUUID()}`
    this.activeRunId = runId
    this.cancelled = false
    this.reportStatus(runId, 'running')
    this.promptPromise = this.agent.prompt(text)
      .then(() => {
        if (this.cancelled) this.reportStatus(runId, 'cancelled')
        else this.reportStatus(runId, 'idle')
      })
      .catch((error: unknown) => {
        this.reportStatus(runId, this.cancelled ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        this.activeRunId = undefined
        this.promptPromise = undefined
      })
    await this.promptPromise
  }

  cancel(): void {
    if (this.activeRunId === undefined) return
    this.cancelled = true
    this.agent.abort()
  }
}

function createTools(
  executeTool: (toolName: string, args: unknown) => Promise<ToolExecutionResult>,
  supportsImages: boolean,
): AgentTool[] {
  const tools: AgentTool[] = [
    tool('read_file', 'Read File', 'Read a UTF-8 text file with line numbers. For binary files, use shell or view_image.', Type.Object({
      path: Type.String({ description: 'Path relative to the managed workspace or an absolute path inside it' }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_000 })),
    }), executeTool),
    tool('list_dir', 'List Directory', 'List files in the managed workspace.', Type.Object({
      path: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    }), executeTool),
    tool('search_files', 'Search Files', 'Search UTF-8 text files for a literal string.', Type.Object({
      path: Type.Optional(Type.String()),
      query: Type.String({ minLength: 1, maxLength: 500 }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }), executeTool),
    tool('shell', 'Shell', 'Run a command in the local sandbox. Network is denied. Use this to inspect or convert arbitrary file formats.', Type.Object({
      command: Type.String({ minLength: 1, maxLength: 20_000 }),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
    }), executeTool),
    tool('employee_intake_create', 'Create Employee Intake', 'Create a persistent batch of employee drafts from inspected files.', Type.Object({
      employees: Type.Array(Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        fields: Type.Record(Type.String(), Type.Object({
          value: Type.String(),
          source: Type.Optional(Type.Union([
            Type.Literal('document'),
            Type.Literal('user'),
            Type.Literal('inferred'),
          ])),
          confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          evidence: Type.Optional(Type.Array(Type.String())),
        })),
        sourceFiles: Type.Optional(Type.Array(Type.String())),
      }), { minItems: 1, maxItems: 500 }),
    }), executeTool),
    tool('employee_intake_get', 'Get Employee Intake', 'Read the current employee intake revision and grouped issues.', Type.Object({
      includeEmployees: Type.Optional(Type.Boolean()),
    }), executeTool),
    tool('employee_intake_update', 'Update Employee Intake', 'Apply corrections to one employee draft using its current revision.', Type.Object({
      employeeId: Type.String({ minLength: 1 }),
      fields: Type.Record(Type.String(), Type.String()),
      expectedRevision: Type.Integer({ minimum: 1 }),
    }), executeTool),
    tool('employee_intake_preview', 'Preview Employee Intake', 'Validate the current intake against Barn Cloud duplicates and required fields. This does not create employees.', Type.Object({}), executeTool),
    tool('employee_search', 'Search Employees', 'Search employees in the signed-in tenant by number, name, email, organization or status.', Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      status: Type.Optional(Type.Union([
        Type.Literal('preboarding'),
        Type.Literal('onboarding'),
        Type.Literal('probation'),
        Type.Literal('active'),
        Type.Literal('offboarding'),
        Type.Literal('terminated'),
      ])),
      orgUnitId: Type.Optional(Type.String()),
      orgUnitCode: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      fields: Type.Optional(Type.String()),
    }), executeTool),
    tool('employee_get', 'Get Employee', 'Read one employee with current organization, manager, hire date, status and version.', Type.Object({
      employeeId: Type.String({ minLength: 1 }),
    }), executeTool),
    tool('org_unit_get', 'Get Organization Unit', 'Read one organization unit by ID or code.', Type.Object({
      idOrCode: Type.String({ minLength: 1 }),
    }), executeTool),
    tool('employee_list_by_org', 'List Employees By Organization', 'List current employees assigned to an organization unit.', Type.Object({
      orgUnitId: Type.Optional(Type.String()),
      orgUnitCode: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }), executeTool),
    tool('lifecycle_propose_transition', 'Propose Lifecycle Transition', 'Create a pending lifecycle proposal. This never changes employee state; explicit user approval is required.', Type.Object({
      employeeId: Type.String({ minLength: 1 }),
      toStatus: Type.Union([
        Type.Literal('preboarding'),
        Type.Literal('onboarding'),
        Type.Literal('probation'),
        Type.Literal('active'),
        Type.Literal('offboarding'),
        Type.Literal('terminated'),
      ]),
      effectiveDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      reason: Type.String({ minLength: 3, maxLength: 1_000 }),
    }), executeTool),
  ]

  if (supportsImages) {
    tools.push(tool('view_image', 'View Image', 'Attach a local PNG, JPEG, WebP, or GIF image to the conversation.', Type.Object({
      path: Type.String({ minLength: 1 }),
    }), executeTool))
  }
  return tools
}

function tool(
  name: string,
  label: string,
  description: string,
  parameters: ReturnType<typeof Type.Object>,
  executeTool: (toolName: string, args: unknown) => Promise<ToolExecutionResult>,
): AgentTool {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const result = await executeTool(name, args)
      return {
        content: result.content,
        details: (result.details ?? null) as never,
        ...(result.isError === true ? { isError: true } : {}),
      }
    },
  }
}

function workerModel(descriptor: WorkerSessionSeed['model']): Model<Api> {
  return {
    id: descriptor.id,
    name: descriptor.name,
    api: descriptor.api as Api,
    provider: descriptor.providerId as never,
    baseUrl: 'worker://host',
    reasoning: descriptor.reasoning,
    input: descriptor.input,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
  }
}

function isLlmMessage(message: AgentMessage): boolean {
  return message.role === 'system'
    || message.role === 'user'
    || message.role === 'assistant'
    || message.role === 'toolResult'
}

function serializableOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
  if (options === undefined) return {}
  const serializable = JSON.parse(JSON.stringify(options)) as Record<string, unknown>
  delete serializable.signal
  return serializable
}

function serializedToolArguments(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: message }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  }
}

function stripImagePayloads(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message
  return {
    ...message,
    content: message.content.map((content) => content.type === 'image'
      ? { type: 'text', text: '[image omitted from persisted transcript]' }
      : content),
  }
}
