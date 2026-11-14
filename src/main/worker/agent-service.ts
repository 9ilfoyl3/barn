import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { resolveReasoningEffort } from '../../shared/models'
import type {
  SessionLiveEvent,
  SessionSummary,
  AttachmentDescriptor,
  SessionTimelineEvent,
} from '../../shared/models'
import type { WorkerToHostMessage } from '../../shared/agent-protocol'
import { ModelStreamBroker } from '../models/model-stream-broker'
import type { ModelService } from '../models/model-service'
import type { ToolService } from '../tools/tool-service'
import type { SessionStore } from '../session/session-store'
import { WorkerSupervisor, type WorkerSupervisorStatus } from './worker-supervisor'

export class AgentService {
  private readonly broker: ModelStreamBroker
  private readonly openSessions = new Map<string, string>()
  private readonly liveListeners = new Set<(event: SessionLiveEvent) => void>()

  constructor(
    private readonly supervisor: WorkerSupervisor,
    private readonly models: ModelService,
    private readonly sessions: SessionStore,
    private readonly tools: ToolService,
  ) {
    this.broker = new ModelStreamBroker(models, (message) => supervisor.post(message))
    supervisor.onMessage((message) => this.handleWorkerMessage(message))
    supervisor.onStatus((status) => this.handleWorkerStatus(status))
  }

  async start(): Promise<void> {
    await this.supervisor.start()
  }

  async prompt(
    sessionId: string,
    text: string,
    attachments: AttachmentDescriptor[] = [],
    workingDirectory?: string,
  ): Promise<SessionSummary> {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new Error('Prompt cannot be empty')
    const snapshot = await this.models.getSnapshot()
    const selection = snapshot.defaultModel
    if (selection === undefined) throw new Error('Configure a default model before chatting')
    const model = this.models.getModelDescriptor(selection)
    if (model === undefined) throw new Error('The selected model is no longer available')
    const reasoningEffort = resolveReasoningEffort(
      snapshot.defaultReasoningEffort,
      model.reasoningEfforts,
    )
    let session = this.sessions.ensureSession(sessionId, 'New session', workingDirectory)
    if (workingDirectory !== undefined && session.workingDirectory !== workingDirectory) {
      session = this.sessions.updateWorkingDirectory(sessionId, workingDirectory)
    }

    const modelKey = `${this.models.getModelFingerprint(selection)
      ?? `${selection.providerId}:${selection.modelId}`}:${reasoningEffort ?? 'off'}`
    if (this.openSessions.get(sessionId) !== modelKey) {
      await this.supervisor.openSession({
        sessionId,
        messages: this.loadAgentMessages(sessionId),
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      this.openSessions.set(sessionId, modelKey)
    }

    this.sessions.append(sessionId, [{
      type: 'agent.message',
      data: {
        message: {
          role: 'user',
          content: trimmed,
          timestamp: Date.now(),
        },
        attachments,
      },
      actor: { kind: 'user', id: 'desktop-user' },
    }])
    if (session.title === 'New session') {
      this.sessions.updateTitle(sessionId, titleFromPrompt(trimmed))
    }
    this.sessions.updateStatus(sessionId, 'running')
    this.emit({ type: 'session.updated', session: this.sessions.getSession(sessionId) })
    const workingDirectoryContext = workingDirectory === undefined
      ? ''
      : `\n\nCurrent working directory:\n${workingDirectory}`
    const attachmentContext = attachments.length === 0
      ? ''
      : `\n\nAttached files and folders:\n${attachments.map((file) => `- ${file.path}`).join('\n')}`
    await this.supervisor.prompt(sessionId, `${trimmed}${workingDirectoryContext}${attachmentContext}`)
    return this.sessions.getSession(sessionId)
  }

  async cancel(sessionId: string): Promise<void> {
    this.sessions.getSession(sessionId)
    await this.supervisor.cancel(sessionId)
  }

  setWorkingDirectory(sessionId: string, workingDirectory: string): SessionSummary {
    const session = this.sessions.updateWorkingDirectory(sessionId, workingDirectory)
    this.emit({ type: 'session.updated', session })
    return session
  }

  clearWorkingDirectory(sessionId: string): SessionSummary {
    const session = this.sessions.clearWorkingDirectory(sessionId)
    this.emit({ type: 'session.updated', session })
    return session
  }

  getEvents(sessionId: string): SessionTimelineEvent[] {
    this.sessions.getSession(sessionId)
    return this.sessions.read(sessionId)
  }

  onLiveEvent(listener: (event: SessionLiveEvent) => void): () => void {
    this.liveListeners.add(listener)
    return () => this.liveListeners.delete(listener)
  }

  async stop(): Promise<void> {
    this.broker.abortAll()
    await this.supervisor.stop()
  }

  private handleWorkerMessage(message: WorkerToHostMessage): void {
    switch (message.type) {
      case 'session.append': {
        try {
          const sessionEvent = this.sessions.append(message.sessionId, [{
            type: 'agent.message',
            data: { message: message.message },
            actor: actorForMessage(message.message),
          }])[0]
          if (sessionEvent === undefined) throw new Error('Session event was not persisted')
          // Do not publish a session summary update for every streamed message. The
          // renderer reloads the timeline from those updates, which would duplicate
          // the same assistant turn alongside the transient live stream.
          this.supervisor.post({ type: 'request.ok', requestId: message.requestId, result: true })
        } catch (error) {
          this.supervisor.post({
            type: 'request.error',
            requestId: message.requestId,
            error: errorMessage(error),
          })
        }
        return
      }
      case 'session.event':
        this.emit({
          ...message.event,
          sessionId: message.sessionId,
          runId: message.runId,
        })
        return
      case 'run.status': {
        const status = message.status === 'cancelled' ? 'idle' : message.status
        this.sessions.updateStatus(message.sessionId, status)
        this.emit({
          type: 'run.status',
          sessionId: message.sessionId,
          runId: message.runId,
          status: message.status,
          ...(message.error === undefined ? {} : { error: message.error }),
        })
        // Prompt start already published the running summary. Only publish
        // another summary when the run reaches a terminal state.
        if (message.status !== 'running') {
          this.emit({ type: 'session.updated', session: this.sessions.getSession(message.sessionId) })
        }
        return
      }
      case 'model.start':
        this.broker.start(message)
        return
      case 'model.abort':
        this.broker.abort(message.requestId)
        return
      case 'tool.execute':
        void this.tools.execute(message.toolName, message.args, {
          workingDirectory: this.sessions.getSession(message.sessionId).workingDirectory,
        })
          .then((result) => {
            this.supervisor.post({
              type: 'request.ok',
              requestId: message.requestId,
              result,
            })
          })
          .catch((error: unknown) => this.supervisor.post({
            type: 'request.error',
            requestId: message.requestId,
            error: errorMessage(error),
          }))
        return
      case 'request.ok':
      case 'request.error':
      case 'worker.ready':
        return
    }
  }

  private handleWorkerStatus(status: WorkerSupervisorStatus): void {
    if (status.state !== 'crashed') return
    this.broker.abortAll()
    for (const sessionId of this.openSessions.keys()) {
      try {
        this.sessions.updateStatus(sessionId, 'failed')
        this.emit({ type: 'session.updated', session: this.sessions.getSession(sessionId) })
      } catch {
        // The session may have been deleted while the Worker was running.
      }
    }
    this.openSessions.clear()
  }

  private loadAgentMessages(sessionId: string): AgentMessage[] {
    return this.sessions.read(sessionId).flatMap((event): AgentMessage[] => {
      if (event.type !== 'agent.message') return []
      if (!isRecord(event.data) || !('message' in event.data)) return []
      if (!isRecord(event.data.message)) return []
      const message = event.data.message as AgentMessage
      const attachments = attachmentDescriptors(event.data.attachments)
      if (message.role !== 'user' || attachments.length === 0) return [message]
      const context = `\n\nAttached files:\n${attachments.map((file) => `- ${file.path}`).join('\n')}`
      return [{
        ...message,
        content: typeof message.content === 'string' ? `${message.content}${context}` : message.content,
      } as AgentMessage]
    })
  }

  private emit(event: SessionLiveEvent): void {
    for (const listener of this.liveListeners) listener(event)
  }
}

function actorForMessage(message: unknown): { kind: 'user' | 'agent' | 'system'; id: string } {
  if (isRecord(message) && message.role === 'user') return { kind: 'user', id: 'desktop-user' }
  if (isRecord(message) && message.role === 'toolResult') return { kind: 'system', id: 'tool' }
  return { kind: 'agent', id: 'barn' }
}

function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 52 ? oneLine : `${oneLine.slice(0, 49)}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { SessionSummary }

function attachmentDescriptors(value: unknown): AttachmentDescriptor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): AttachmentDescriptor[] => isRecord(entry)
    && typeof entry.name === 'string'
    && typeof entry.path === 'string'
    && typeof entry.size === 'number'
    ? [{
        name: entry.name,
        path: entry.path,
        size: entry.size,
        ...(entry.kind === 'file' || entry.kind === 'directory' ? { kind: entry.kind } : {}),
      }]
    : [])
}
