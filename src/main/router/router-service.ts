import { randomUUID } from 'node:crypto'
import type {
  AttachmentDescriptor,
  ApprovalRequest,
  RouterLiveEvent,
  RouterRequest,
  RouterSnapshot,
  RouterSubmitInput,
  RouterSubmitResult,
  VisibleMessage,
} from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { TaskService } from '../tasks/task-service'
import type { ThreadService } from '../threads/thread-service'
import type { RouterStore } from './router-store'
import type { RouterDecision, RouterDecisionEngine } from './router-decision'
import { formatTaskBrief } from '../../shared/agent-prompts'

const ROUTER_LEASE_MS = 10 * 60 * 1_000
const ROUTER_CONTEXT_MESSAGE_LIMIT = 40
const ROUTER_LEASE_OWNER = 'desktop-router'

type RouterThreads = Pick<ThreadService, 'appendMessage' | 'appendMessageInTransaction' | 'notifyMessage' | 'listMessages'>
type RouterTasks = Pick<TaskService, 'create' | 'get' | 'list' | 'reroute' | 'updateRoutine' | 'updateStatus'>
type RouterSessions = Pick<SessionStore, 'transaction'>

export interface RouterServiceOptions {
  leaseMs?: number
  contextMessageLimit?: number
  now?: () => Date
  timezone?: string
  createRequestId?: () => string
  getConnectorContext?: () => Promise<Array<{ id: string; kind: string; name: string; status: string; capabilities: string[] }>>
  getPendingApprovals?: () => ApprovalRequest[]
}

/** Serial Router lane: admitted requests are routed through validated model tool decisions. */
export class RouterService {
  private readonly listeners = new Set<(event: RouterLiveEvent) => void>()
  private readonly activeDecisions = new Map<string, AbortController>()
  private readonly leaseMs: number
  private readonly contextMessageLimit: number
  private readonly now: () => Date
  private readonly timezone: string
  private readonly createRequestId: () => string
  private readonly getConnectorContext: () => Promise<Array<{ id: string; kind: string; name: string; status: string; capabilities: string[] }>>
  private readonly getPendingApprovals: () => ApprovalRequest[]
  private started = false
  private draining = false
  private scheduled: NodeJS.Immediate | undefined

  constructor(
    private readonly store: RouterStore,
    private readonly threads: RouterThreads,
    private readonly sessions: RouterSessions,
    private readonly tasks: RouterTasks,
    private readonly decisions: RouterDecisionEngine,
    options: RouterServiceOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? ROUTER_LEASE_MS
    this.contextMessageLimit = options.contextMessageLimit ?? ROUTER_CONTEXT_MESSAGE_LIMIT
    this.now = options.now ?? (() => new Date())
    this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    this.createRequestId = options.createRequestId ?? randomUUID
    this.getConnectorContext = options.getConnectorContext ?? (async () => [])
    this.getPendingApprovals = options.getPendingApprovals ?? (() => [])
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const request of this.store.recoverExpired(this.now())) {
      this.emit({ type: 'router.request-updated', request })
    }
    this.backfillFailedRequestMessages()
    this.schedule()
  }

  stop(): void {
    this.started = false
    for (const controller of this.activeDecisions.values()) controller.abort()
    this.activeDecisions.clear()
    if (this.scheduled !== undefined) clearImmediate(this.scheduled)
    this.scheduled = undefined
  }

  async submit(input: RouterSubmitInput): Promise<RouterSubmitResult> {
    const text = input.text.trim()
    if (text.length === 0) throw new Error('Router message cannot be empty')
    if (text.length > 2_000_000) throw new Error('Router message is too large')
    const requestId = this.createRequestId()
    const attachments = normalizeAttachments(input.attachments)
    const accepted = this.sessions.transaction(() => {
      const userMessage = this.threads.appendMessageInTransaction({
        clientMessageId: input.clientMessageId?.trim() || `router-user:${randomUUID()}`,
        role: 'user',
        content: text,
        metadata: {
          routerRequestId: requestId,
          attachmentNames: attachments.map((attachment) => attachment.name),
          attachments,
          ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
        },
        sourceRefs: [`router:${requestId}`],
      })
      const request = this.store.accept({
        requestId,
        threadId: userMessage.threadId,
        userMessage,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
      })
      return { userMessage, request }
    })

    this.threads.notifyMessage(accepted.userMessage)
    this.emit({ type: 'router.request-updated', request: accepted.request })
    this.schedule()
    return accepted
  }

  getSnapshot(): RouterSnapshot {
    return this.store.snapshot()
  }

  async cancel(requestId: string): Promise<RouterRequest> {
    const request = this.store.get(requestId)
    if (request.status === 'cancelled' || request.status === 'completed' || request.status === 'failed') return request
    const cancelled = this.store.cancel(requestId, this.now())
    this.emit({ type: 'router.request-updated', request: cancelled })
    this.activeDecisions.get(requestId)?.abort()
    return cancelled
  }

  onEvent(listener: (event: RouterLiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private backfillFailedRequestMessages(): void {
    for (const request of this.store.list().filter((entry) => entry.status === 'failed' && entry.replyMessageId === undefined)) {
      try {
        const userMessage = this.threads.listMessages({ limit: 1_000 })
          .find((message) => message.id === request.userMessageId)
        if (userMessage === undefined) continue
        const locale = userMessage.metadata.locale === 'zh-CN' ? 'zh-CN' : 'en'
        const detail = request.error ?? 'Router request failed'
        const reply = this.threads.appendMessage({
          clientMessageId: `router-error:${request.id}`,
          role: 'assistant',
          content: routerFailureText(detail, locale),
          metadata: {
            routerRequestId: request.id,
            routerError: true,
            routerErrorDetail: detail.slice(0, 500),
          },
          sourceRefs: [`router:${request.id}`],
        })
        const repaired = this.store.fail(
          request.id,
          detail,
          new Date(request.finishedAt ?? request.updatedAt),
          reply.id,
        )
        this.emit({ type: 'router.request-updated', request: repaired })
      } catch {
        // A malformed historical request must not stop Router startup.
      }
    }
  }

  private schedule(): void {
    if (!this.started || this.scheduled !== undefined) return
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (!this.started || this.draining) return
    this.draining = true
    try {
      while (this.started) {
        const claimed = this.store.claimNext(ROUTER_LEASE_OWNER, this.leaseMs, this.now())
        if (claimed === undefined) break
        this.emit({ type: 'router.request-updated', request: claimed.request })
        await this.process(claimed.request)
      }
    } finally {
      this.draining = false
      if (this.started && this.store.snapshot().queuedCount > 0) this.schedule()
    }
  }

  private async process(request: RouterRequest): Promise<void> {
    const controller = new AbortController()
    this.activeDecisions.set(request.id, controller)
    try {
      const userMessage = this.threads.listMessages({ limit: 1_000 })
        .find((message) => message.id === request.userMessageId)
      if (userMessage === undefined) throw new Error('Router user message is missing from the Principal Thread')
      const text = visibleText(userMessage.content)
      const attachments = attachmentList(userMessage.metadata.attachments)
      const workingDirectory = stringMetadata(userMessage.metadata.workingDirectory)
      const locale = userMessage.metadata.locale === 'zh-CN' ? 'zh-CN' : 'en'
      const connectors = await this.getConnectorContext().catch(() => [])
      const pendingApprovals = this.getPendingApprovals()
      const decision = await this.decisions.decide({
        text,
        attachments: attachments.map((attachment) => ({
          name: attachment.name,
          ...(attachment.kind === undefined ? {} : { kind: attachment.kind }),
        })),
        recentMessages: this.recentMessages(userMessage),
        activeTasks: this.tasks.list().filter((task) => task.status !== 'completed' && task.status !== 'cancelled'),
        pendingApprovals,
        connectors,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        now: this.now(),
        timezone: this.timezone,
        locale,
      }, controller.signal)
      if (this.store.get(request.id).status === 'cancelled') return
      await this.applyDecision(request, userMessage, text, attachments, workingDirectory, locale, decision)
    } catch (error) {
      const current = this.store.get(request.id)
      if (current.status === 'cancelled' || controller.signal.aborted) return
      const detail = errorMessage(error)
      let replyMessageId: string | undefined
      try {
        const userMessage = this.threads.listMessages({ limit: 1_000 })
          .find((message) => message.id === request.userMessageId)
        const locale = userMessage?.metadata.locale === 'zh-CN' ? 'zh-CN' : 'en'
        const reply = this.threads.appendMessage({
          clientMessageId: `router-error:${request.id}`,
          role: 'assistant',
          content: routerFailureText(detail, locale),
          metadata: {
            routerRequestId: request.id,
            routerError: true,
            routerErrorDetail: detail.slice(0, 500),
          },
          sourceRefs: [`router:${request.id}`],
        })
        replyMessageId = reply.id
      } catch {
        // The failed request remains durable even if projecting the error message fails.
      }
      const failed = this.store.fail(request.id, detail, this.now(), replyMessageId)
      this.emit({ type: 'router.request-updated', request: failed })
    } finally {
      this.activeDecisions.delete(request.id)
    }
  }

  private async applyDecision(
    request: RouterRequest,
    userMessage: VisibleMessage,
    text: string,
    attachments: AttachmentDescriptor[],
    workingDirectory: string | undefined,
    locale: 'en' | 'zh-CN',
    decision: RouterDecision,
  ): Promise<void> {
    if (decision.action === 'reply' || decision.action === 'clarify') {
      const content = decision.action === 'reply' ? decision.text : decision.question
      const reply = this.threads.appendMessage({
        clientMessageId: `router-reply:${request.id}`,
        role: 'assistant',
        content,
        metadata: {
          routerRequestId: request.id,
          ...(decision.memoryRefs.length ? { memoryRefs: decision.memoryRefs } : {}),
        },
        sourceRefs: [`router:${request.id}`, `thread:${userMessage.id}`, ...decision.memoryRefs],
      })
      this.finish(request.id, {
        kind: decision.action,
        confidence: decision.confidence,
        rationaleCodes: decision.rationaleCodes,
        replyMessageId: reply.id,
      })
      return
    }

    if (decision.action === 'create_task') {
      const task = this.tasks.create({
        title: decision.title,
        origin: 'user',
        status: 'queued',
        kind: 'work',
        contract: decision.taskContract,
        prompt: taskPrompt(decision.taskContract),
        visiblePrompt: text,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(attachments.length === 0 ? {} : { attachments }),
      })
      this.finish(request.id, {
        kind: 'create_task',
        confidence: decision.confidence,
        rationaleCodes: decision.rationaleCodes,
        taskId: task.id,
      })
      return
    }

    if (decision.action === 'schedule') {
      const task = this.tasks.create({
        title: decision.title,
        origin: 'user',
        status: 'queued',
        kind: 'reminder',
        scheduledFor: decision.scheduledFor,
        recurrence: decision.recurrence,
        timezone: decision.timezone,
        prompt: decision.text,
        visiblePrompt: decision.text,
      })
      const scheduledLabel = recurrenceScheduleLabel(decision, locale)
      const reminderText = locale === 'zh-CN'
        ? decision.text.replace(/^提醒我(?:要|去)?\s*/u, '').trim()
        : decision.text
      const reply = this.threads.appendMessage({
        clientMessageId: `router-schedule:${request.id}`,
        role: 'assistant',
        content: locale === 'zh-CN'
          ? `好，${scheduledLabel} 我会提醒你：${reminderText}`
          : `Okay. I’ll remind you on ${scheduledLabel}: ${reminderText}`,
        metadata: { routerRequestId: request.id, taskId: task.id, routineId: task.id },
        sourceRefs: [`router:${request.id}`, `task:${task.id}`],
      })
      this.finish(request.id, {
        kind: 'create_task',
        confidence: decision.confidence,
        rationaleCodes: decision.rationaleCodes,
        taskId: task.id,
        replyMessageId: reply.id,
      })
      return
    }

    if (decision.action === 'update_routine') {
      const task = this.tasks.get(decision.taskId)
      if (task.kind !== 'reminder') throw new Error('routine.update can only modify reminder routines')
      const updated = this.tasks.updateRoutine(task.id, {
        title: decision.title,
        text: decision.text,
        scheduledFor: decision.scheduledFor,
        recurrence: decision.recurrence,
        timezone: decision.timezone,
      })
      const scheduledLabel = formatRoutineLabel(
        decision.scheduledFor,
        decision.timezone,
        decision.recurrence,
        locale,
      )
      const reminderText = locale === 'zh-CN'
        ? decision.text.replace(/^提醒我(?:要|去)?\s*/u, '').trim()
        : decision.text
      const reply = this.threads.appendMessage({
        clientMessageId: `router-routine-update:${request.id}`,
        role: 'assistant',
        content: locale === 'zh-CN'
          ? `好，已改为${scheduledLabel}提醒你：${reminderText}`
          : `Updated. I’ll remind you ${scheduledLabel}: ${reminderText}`,
        metadata: { routerRequestId: request.id, taskId: updated.id, routineId: updated.id },
        sourceRefs: [`router:${request.id}`, `task:${updated.id}`],
      })
      this.finish(request.id, {
        kind: 'update_task',
        confidence: decision.confidence,
        rationaleCodes: decision.rationaleCodes,
        taskId: updated.id,
        replyMessageId: reply.id,
      })
      return
    }

    if (decision.action === 'cancel_task') {
      const task = this.tasks.get(decision.taskId)
      this.tasks.updateStatus(task.id, {
        status: 'cancelled',
        detail: decision.reason?.trim() || 'Cancelled by the Router.',
      })
      const reply = this.threads.appendMessage({
        clientMessageId: `router-cancel:${request.id}`,
        role: 'assistant',
        content: locale === 'zh-CN' ? `已取消“${task.title}”。` : `Cancelled “${task.title}”.`,
        metadata: { routerRequestId: request.id, taskId: task.id },
        sourceRefs: [`router:${request.id}`, `task:${task.id}`],
      })
      this.finish(request.id, {
        kind: 'cancel_task',
        confidence: decision.confidence,
        rationaleCodes: decision.rationaleCodes,
        taskId: task.id,
        replyMessageId: reply.id,
      })
      return
    }

    const task = this.tasks.get(decision.taskId)
    const rerouted = this.tasks.reroute(task.id, decision.instruction)
    this.finish(request.id, {
      kind: 'update_task',
      confidence: decision.confidence,
      rationaleCodes: decision.rationaleCodes,
      taskId: rerouted.id,
    })
  }

  private recentMessages(userMessage: VisibleMessage): VisibleMessage[] {
    return this.threads.listMessages({ limit: this.contextMessageLimit })
      .filter((message) => message.seq < userMessage.seq && (message.role === 'user' || message.role === 'assistant'))
  }

  private finish(requestId: string, decision: Parameters<RouterStore['complete']>[1]): void {
    const completed = this.store.complete(requestId, decision, this.now())
    this.emit({ type: 'router.request-updated', request: completed })
  }

  private emit(event: RouterLiveEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function routerFailureText(detail: string, locale: 'en' | 'zh-CN'): string {
  if (/invalid tool decision|invalid json|structured/i.test(detail)) {
    return locale === 'zh-CN'
      ? '这次请求没有完成：Router 返回了无法识别的结果。请再发一次，或把要求写得更具体一些。'
      : 'This request did not complete because the Router returned an invalid decision. Please try again or make the request more specific.'
  }
  return locale === 'zh-CN'
    ? '这次请求没有完成：Barn 暂时无法处理当前消息。请检查模型连接后重试。'
    : 'This request did not complete because Barn could not process the message. Check the model connection and try again.'
}

function taskPrompt(contract: NonNullable<Extract<RouterDecision, { action: 'create_task' }>['taskContract']>): string {
  return formatTaskBrief(contract)
}

function recurrenceScheduleLabel(
  decision: Extract<RouterDecision, { action: 'schedule' }>,
  locale: 'en' | 'zh-CN',
): string {
  return formatRoutineLabel(decision.scheduledFor, decision.timezone, decision.recurrence, locale)
}

function formatRoutineLabel(
  scheduledFor: string,
  timezone: string,
  recurrence: Extract<RouterDecision, { action: 'schedule' }>['recurrence'],
  locale: 'en' | 'zh-CN',
): string {
  if (recurrence === 'none') return formatSchedule(scheduledFor, timezone, locale)
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(scheduledFor))
  if (locale === 'zh-CN') {
    if (recurrence === 'daily') return `每天 ${time}`
    if (recurrence === 'weekdays') return `每个工作日 ${time}`
    return `每周 ${time}`
  }
  if (recurrence === 'daily') return `every day at ${time}`
  if (recurrence === 'weekdays') return `every weekday at ${time}`
  return `every week at ${time}`
}

function formatSchedule(value: string, timezone: string, locale: 'en' | 'zh-CN'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(value))
  } catch {
    return new Date(value).toISOString()
  }
}

function normalizeAttachments(value: AttachmentDescriptor[] | undefined): AttachmentDescriptor[] {
  if (value === undefined) return []
  return value.slice(0, 50).map((attachment) => {
    const name = attachment.name.trim()
    const path = attachment.path.trim()
    if (name.length === 0 || path.length === 0) throw new Error('Attachment name and path are required')
    if (name.length > 500 || path.length > 4_000) throw new Error('Attachment metadata is too large')
    if (!Number.isInteger(attachment.size) || attachment.size < 0) throw new Error('Attachment size must be non-negative')
    return {
      name,
      path,
      size: attachment.size,
      ...(attachment.kind === 'file' || attachment.kind === 'directory' ? { kind: attachment.kind } : {}),
    }
  })
}

function attachmentList(value: unknown): AttachmentDescriptor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): AttachmentDescriptor[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.path !== 'string' || typeof record.size !== 'number') return []
    return [{
      name: record.name,
      path: record.path,
      size: record.size,
      ...(record.kind === 'file' || record.kind === 'directory' ? { kind: record.kind } : {}),
    }]
  })
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part): string[] => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return []
    const record = part as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('\n')
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
