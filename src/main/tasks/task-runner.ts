import type { AgentPromptOptions, AttachmentDescriptor, SessionLiveEvent, Task, TaskResultEnvelope } from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { ThreadService } from '../threads/thread-service'
import type { TaskService } from './task-service'

export interface TaskRunnerOptions {
  maxConcurrent?: number
  now?: () => Date
  routerRequestIdForTask?: (taskId: string) => string | undefined
}

export interface TaskAgent {
  prompt(
    sessionId: string,
    text: string,
    attachments?: AttachmentDescriptor[],
    workingDirectory?: string,
    visibleText?: string,
    options?: AgentPromptOptions,
  ): Promise<unknown>
  cancel(sessionId: string): Promise<void>
  onLiveEvent(listener: (event: SessionLiveEvent) => void): () => void
}

interface ActiveTask {
  taskId: string
  workerSessionId: string
  cancelRequested: boolean
}

/** Runs queued Tasks through AgentService and projects run outcomes back into durable Task state. */
export class TaskRunner {
  private readonly maxConcurrent: number
  private readonly now: () => Date
  private readonly routerRequestIdForTask: (taskId: string) => string | undefined
  private readonly active = new Map<string, ActiveTask>()
  private readonly activeSessions = new Map<string, string>()
  private disposers: Array<() => void> = []
  private scheduled: NodeJS.Immediate | undefined
  private wakeTimer: NodeJS.Timeout | undefined
  private draining = false
  private started = false

  constructor(
    private readonly agent: TaskAgent,
    private readonly tasks: Pick<
      TaskService,
      'list' | 'updateStatus' | 'recordResult' | 'rescheduleReminder' | 'assignSession' | 'onEvent'
    >,
    private readonly sessions: Pick<SessionStore, 'append' | 'createSession' | 'getSession' | 'read'>,
    options: TaskRunnerOptions = {},
    private readonly threads?: Pick<ThreadService, 'appendMessage'>,
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3)
    this.now = options.now ?? (() => new Date())
    this.routerRequestIdForTask = options.routerRequestIdForTask ?? (() => undefined)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.disposers.push(
      this.tasks.onEvent((event) => {
        if (event.type !== 'task.updated') return
        const task = event.task
        if (task.status === 'queued') {
          if (this.active.has(task.id)) {
            void this.rerouteActive(task.id)
          } else {
            this.schedule()
          }
          return
        }
        if (task.status === 'cancelled') {
          void this.cancelActive(task.id)
          return
        }
        if (task.status === 'waiting' || task.status === 'completed' || task.status === 'failed') {
          this.removeActive(task.id)
          this.schedule()
        }
      }),
      this.agent.onLiveEvent((event) => this.handleRunEvent(event)),
    )
    this.schedule()
  }

  /** Nudge the runner after wake, network recovery, or an external lifecycle event. */
  kick(): void {
    this.schedule()
  }

  stop(): void {
    this.started = false
    if (this.scheduled !== undefined) {
      clearImmediate(this.scheduled)
      this.scheduled = undefined
    }
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = undefined
    }
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  private schedule(): void {
    if (!this.started || this.scheduled !== undefined) return
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = undefined
    }
    if (this.active.size >= this.maxConcurrent) return
    const now = this.now().getTime()
    const queued = this.tasks.list()
      .filter((task) => task.status === 'queued' && !this.active.has(task.id))
    if (queued.length === 0) return
    const scheduled = queued.map((task) => ({
      task,
      dueAt: task.scheduledFor === undefined ? now : new Date(task.scheduledFor).getTime(),
    }))
    const due = scheduled.filter((entry) => !Number.isFinite(entry.dueAt) || entry.dueAt <= now)
    if (due.length === 0) {
      const future = scheduled
        .filter((entry) => Number.isFinite(entry.dueAt) && entry.dueAt > now)
        .toSorted((left, right) => left.dueAt - right.dueAt)[0]
      if (future === undefined) return
      const delay = Math.min(future.dueAt - now, 2_147_483_647)
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined
        this.schedule()
      }, Math.max(1, delay))
      this.wakeTimer.unref()
      return
    }
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (!this.started || this.draining) return
    this.draining = true
    try {
      while (this.started && this.active.size < this.maxConcurrent) {
        const task = this.nextQueuedTask()
        if (task === undefined) return
        if (task.prompt === undefined) {
          this.tasks.updateStatus(task.id, {
            status: 'waiting',
            waitingReason: 'input',
            detail: 'Add instructions before this task can run.',
          })
          continue
        }
        await this.launch(task)
      }
    } finally {
      this.draining = false
      if (this.started && this.active.size < this.maxConcurrent) this.schedule()
    }
  }

  private nextQueuedTask(): Task | undefined {
    const now = this.now().getTime()
    return this.tasks.list().find((task) => (
      task.status === 'queued'
      && !this.active.has(task.id)
      && (task.scheduledFor === undefined || new Date(task.scheduledFor).getTime() <= now)
    ))
  }

  private async launch(task: Task): Promise<void> {
    if (task.kind === 'reminder') {
      this.tasks.updateStatus(task.id, { status: 'running', detail: 'Delivering reminder.' })
      const routerRequestId = this.routerRequestIdForTask(task.id)
      this.threads?.appendMessage({
        clientMessageId: `task-reminder:${task.id}`,
        role: 'assistant',
        content: reminderDeliveryText(task.visiblePrompt ?? task.title),
        metadata: {
          taskId: task.id,
          routineId: task.id,
          routineDelivery: true,
          routineTitle: task.title,
          routinePrompt: task.visiblePrompt ?? task.title,
          routineRecurrence: task.recurrence ?? 'none',
          ...(routerRequestId === undefined ? {} : { routerRequestId }),
        },
        sourceRefs: [`task:${task.id}`],
      })
      const nextOccurrence = nextReminderOccurrence(task)
      if (nextOccurrence === undefined) {
        this.tasks.updateStatus(task.id, { status: 'completed', detail: '' })
      } else {
        this.tasks.rescheduleReminder(task.id, nextOccurrence)
      }
      this.schedule()
      return
    }
    const workerSession = task.sessionId === undefined
      ? this.sessions.createSession(task.title)
      : this.sessions.getSession(task.sessionId)
    const continued = task.detail === 'New instructions added; task requeued.'
      || this.sessions.read(workerSession.id).some(isTaskUserMessage)
    const active: ActiveTask = {
      taskId: task.id,
      workerSessionId: workerSession.id,
      cancelRequested: false,
    }
    this.active.set(task.id, active)
    this.activeSessions.set(workerSession.id, task.id)
    try {
      this.tasks.updateStatus(task.id, { status: 'running', detail: 'Task execution started.' })
      this.tasks.assignSession(task.id, workerSession.id)
      await this.promptWorker(task, workerSession.id, continued)
    } catch (error) {
      this.failActive(task.id, errorMessage(error))
    }
  }

  private handleRunEvent(event: SessionLiveEvent): void {
    if (event.type === 'session.updated' && event.session.status === 'failed') {
      const taskId = this.activeSessions.get(event.session.id)
      if (taskId === undefined) return
      this.failActive(taskId, 'The Agent Worker stopped unexpectedly.')
      return
    }
    if (event.type !== 'run.status') return
    const taskId = this.activeSessions.get(event.sessionId)
    if (taskId === undefined) return
    const active = this.active.get(taskId)
    if (active === undefined) return
    if (event.status === 'running') return

    if (event.status === 'failed') {
      this.failActive(taskId, event.error ?? 'Task execution failed.', active)
      return
    }
    if (event.status === 'cancelled' || active.cancelRequested) {
      this.failActive(taskId, event.error ?? 'Task cancelled.', active, 'cancelled')
      return
    }

    const answer = finalAssistantMessage(this.sessions.read(active.workerSessionId))
    if (answer === undefined) {
      this.failActive(taskId, 'The Agent Worker finished without a final answer.', active)
      return
    }
    this.removeActive(taskId)
    const result: TaskResultEnvelope = {
      outcome: 'completed',
      summary: answer.text,
      artifacts: taskArtifacts(this.tasks.list().find((task) => task.id === taskId)),
      evidenceRefs: [`session:${active.workerSessionId}:event:${answer.eventId}`],
      limitations: [],
      externalEffectReceipts: [],
    }
    this.tasks.recordResult(taskId, result)
    void this.projectTaskResult(taskId, active.workerSessionId, result, answer.eventId)
    this.schedule()
  }

  private failActive(
    taskId: string,
    detail: string,
    active = this.active.get(taskId),
    status: 'failed' | 'cancelled' = 'failed',
  ): void {
    if (active === undefined) return
    this.removeActive(taskId)
    void this.agent.cancel(active.workerSessionId).catch(() => {})
    const current = this.tasks.list().find((task) => task.id === taskId)
    if (current === undefined || current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return
    const result: TaskResultEnvelope = {
      outcome: status === 'cancelled' ? 'cancelled' : 'failed',
      summary: detail,
      artifacts: [],
      evidenceRefs: [`session:${active.workerSessionId}`],
      limitations: [detail],
      externalEffectReceipts: [],
    }
    this.tasks.recordResult(taskId, result)
    if (status === 'failed') void this.projectTaskResult(taskId, active.workerSessionId, result)
    this.schedule()
  }

  private async promptWorker(task: Task, sessionId: string, continued: boolean): Promise<void> {
    await this.agent.prompt(
      sessionId,
      continued ? task.visiblePrompt ?? task.prompt! : task.prompt!,
      task.attachments ?? [],
      task.workingDirectory,
      task.visiblePrompt,
      {
        recordUserMessage: !continued,
        projectUserMessage: false,
        projectAssistantMessage: false,
        ...(continued ? {} : { userActorRole: 'router' as const }),
        assistantActorRole: 'worker',
        visibleActivity: false,
        visibleMetadata: { taskId: task.id },
        clientMessageIdPrefix: `task-assistant:${task.id}`,
      },
    )
  }

  private async projectTaskResult(
    taskId: string,
    sessionId: string,
    result: TaskResultEnvelope,
    sessionEventId?: string,
  ): Promise<void> {
    const task = this.tasks.list().find((candidate) => candidate.id === taskId)
    if (task === undefined || result.summary.trim().length === 0) return
    const routerRequestId = this.routerRequestIdForTask(taskId)
    this.threads?.appendMessage({
      clientMessageId: `task-result:${taskId}:${sessionEventId ?? result.outcome}`,
      role: 'assistant',
      content: result.summary,
      metadata: {
        taskId,
        sessionId,
        taskResult: true,
        taskOutcome: result.outcome,
        ...(sessionEventId === undefined ? {} : { sessionEventId }),
        ...(routerRequestId === undefined ? {} : { routerRequestId }),
      },
      sourceRefs: [
        `task:${taskId}`,
        `session:${sessionId}`,
        ...result.evidenceRefs,
        ...(routerRequestId === undefined ? [] : [`router:${routerRequestId}`]),
      ],
    })
  }

  private async rerouteActive(taskId: string): Promise<void> {
    const active = this.active.get(taskId)
    if (active === undefined) return
    active.cancelRequested = true
    this.removeActive(taskId)
    try {
      await this.agent.cancel(active.workerSessionId)
    } catch {
      // The Task is already requeued; an already stopped participant needs no further action.
    } finally {
      this.schedule()
    }
  }

  private async cancelActive(taskId: string): Promise<void> {
    const active = this.active.get(taskId)
    if (active === undefined) return
    active.cancelRequested = true
    try {
      await this.agent.cancel(active.workerSessionId)
    } catch {
      this.removeActive(taskId)
      this.schedule()
    }
  }

  private updateIfActive(taskId: string, update: Parameters<TaskService['updateStatus']>[1]): void {
    const task = this.tasks.list().find((candidate) => candidate.id === taskId)
    if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return
    this.tasks.updateStatus(taskId, update)
  }

  private removeActive(taskId: string): void {
    const active = this.active.get(taskId)
    if (active === undefined) return
    this.active.delete(taskId)
    if (this.activeSessions.get(active.workerSessionId) === taskId) {
      this.activeSessions.delete(active.workerSessionId)
    }
  }
}

function taskArtifacts(task: Task | undefined): string[] {
  if (task?.workingDirectory === undefined) return []
  return [`workspace:${task.workingDirectory}`]
}

function isTaskUserMessage(event: ReturnType<SessionStore['read']>[number]): boolean {
  return event.type === 'agent.message'
    && isRecord(event.data)
    && isRecord(event.data.message)
    && event.data.message.role === 'user'
    && event.data.actorRole !== 'router'
}

function finalAssistantMessage(
  events: ReturnType<SessionStore['read']>,
): { eventId: string; text: string } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'agent.message' || !isRecord(event.data) || !isRecord(event.data.message)) continue
    if (event.data.message.role !== 'assistant') continue
    if (event.data.actorRole !== 'worker') continue
    const text = agentMessageText(event.data.message.content).trim()
    if (text.length > 0) return { eventId: event.eventId, text }
  }
  return undefined
}

function agentMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part): string[] => (
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  )).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nextReminderOccurrence(task: Task): string | undefined {
  if ((task.recurrence ?? 'none') === 'none' || task.scheduledFor === undefined) return undefined
  const previous = new Date(task.scheduledFor)
  if (Number.isNaN(previous.getTime())) return undefined
  const days = task.recurrence === 'weekly' ? 7 : 1
  let next = new Date(previous.getTime() + days * 24 * 60 * 60 * 1_000)
  if (task.recurrence === 'weekdays') {
    while (isWeekend(next, task.timezone)) next = new Date(next.getTime() + 24 * 60 * 60 * 1_000)
  }
  return next.toISOString()
}

function isWeekend(date: Date, timezone: string | undefined): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    ...(timezone === undefined ? {} : { timeZone: timezone }),
  }).format(date)
  return weekday === 'Sat' || weekday === 'Sun'
}

function reminderDeliveryText(text: string): string {
  if (!/[\u3400-\u9fff]/u.test(text)) return `Reminder: ${text}`
  return `提醒：${text.replace(/^提醒我(?:要|去)?\s*/u, '').trim()}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
