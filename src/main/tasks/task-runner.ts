import type { AgentPromptOptions, AttachmentDescriptor, SessionLiveEvent, Task, TaskResultEnvelope } from '../../shared/models'
import type { ActionStatus } from '../actions/types'
import type { SessionStore } from '../session/session-store'
import type { ThreadService } from '../threads/thread-service'
import type { TaskService } from './task-service'

export interface TaskRunnerOptions {
  maxConcurrent?: number
  now?: () => Date
  routerRequestIdForTask?: (taskId: string) => string | undefined
  taskEffectsForTask?: (taskId: string) => TaskEffectSnapshot[]
  leaseMs?: number
  leaseOwner?: string
}

export interface TaskEffectSnapshot {
  id: string
  status: ActionStatus
  approvalId?: string
  lastError?: string
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
  runId: string
  cancelRequested: boolean
}

/** Runs queued Tasks through AgentService and projects run outcomes back into durable Task state. */
export class TaskRunner {
  private readonly maxConcurrent: number
  private readonly now: () => Date
  private readonly routerRequestIdForTask: (taskId: string) => string | undefined
  private readonly taskEffectsForTask: (taskId: string) => TaskEffectSnapshot[]
  private readonly leaseMs: number
  private readonly leaseOwner: string
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
      'get' | 'list' | 'updateStatus' | 'recordResult' | 'recordPendingResult' | 'requestApproval' | 'rescheduleReminder' | 'assignSession' | 'onEvent'
    >,
    private readonly sessions: Pick<SessionStore, 'append' | 'createSession' | 'getSession' | 'read' | 'taskRuns' | 'routines'>,
    options: TaskRunnerOptions = {},
    private readonly threads?: Pick<ThreadService, 'appendMessage'>,
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3)
    this.now = options.now ?? (() => new Date())
    this.routerRequestIdForTask = options.routerRequestIdForTask ?? (() => undefined)
    this.taskEffectsForTask = options.taskEffectsForTask ?? (() => [])
    this.leaseMs = Math.max(5_000, options.leaseMs ?? 120_000)
    this.leaseOwner = options.leaseOwner ?? 'desktop'
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
        if (task.status === 'waiting' && task.waitingReason === 'approval' && this.active.has(task.id)) {
          // The Worker run continues until it publishes its report. The Task is
          // waiting for a person, not finished, and its result must not claim
          // the external effect succeeded before approval.
          return
        }
        if (task.status === 'waiting' || task.status === 'completed' || task.status === 'failed') {
          this.sessions.taskRuns.finishLatest(task.id, task.status, task.detail)
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

  /** Whether this in-memory runner currently owns a worker for the Task. */
  isActive(taskId: string): boolean {
    return this.active.has(taskId)
  }

  /** A bounded view the guard uses to distinguish a healthy run from an orphaned Task row. */
  activeSnapshot(): Array<{ taskId: string; sessionId: string; runId: string }> {
    return [...this.active.values()].map((active) => ({
      taskId: active.taskId,
      sessionId: active.workerSessionId,
      runId: active.runId,
    }))
  }

  /**
   * Restart a silent Worker in the same Session with a bounded status request.
   * The worker protocol cannot accept a second prompt while a turn is running,
   * so the guard stops the current attempt and records a new one.
   */
  async nudge(taskId: string, text: string): Promise<boolean> {
    const active = this.active.get(taskId)
    if (active === undefined) return false
    const task = this.tasks.list().find((candidate) => candidate.id === taskId)
    if (task === undefined || task.status !== 'running') return false
    this.sessions.taskRuns.setStatus(active.runId, 'cancelled', 'Guard requested a progress check.')
    this.removeActive(taskId)
    try {
      await this.agent.cancel(active.workerSessionId)
    } catch {
      // A worker that already stopped can still be asked for a final result.
    }
    await this.waitForSessionIdle(active.workerSessionId)
    const run = this.sessions.taskRuns.start({
      taskId,
      sessionId: active.workerSessionId,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
    })
    this.active.set(taskId, {
      taskId,
      workerSessionId: active.workerSessionId,
      runId: run.id,
      cancelRequested: false,
    })
    this.activeSessions.set(active.workerSessionId, taskId)
    await this.agent.prompt(
      active.workerSessionId,
      text,
      [],
      task.workingDirectory,
      undefined,
      {
        recordUserMessage: true,
        projectUserMessage: false,
        projectAssistantMessage: false,
        userActorRole: 'router',
        assistantActorRole: 'worker',
        visibleActivity: false,
        visibleMetadata: { taskId, taskGuard: true },
        clientMessageIdPrefix: `task-guard:${taskId}`,
        taskId,
      },
    )
    return true
  }

  private async waitForSessionIdle(sessionId: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.sessions.getSession(sessionId).status !== 'running') return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('The Agent Worker did not stop before the guard could ask for a result')
  }

  /** Stop a silent run and return the Task to Needs you without claiming success or failure. */
  async guardPause(taskId: string, detail: string): Promise<boolean> {
    const active = this.active.get(taskId)
    if (active === undefined) return false
    this.removeActive(taskId)
    try {
      await this.agent.cancel(active.workerSessionId)
    } catch {
      // The guard still records the paused Task even when the worker already stopped.
    }
    const current = this.tasks.list().find((task) => task.id === taskId)
    if (current !== undefined && current.status === 'running') {
      this.tasks.updateStatus(taskId, {
        status: 'waiting',
        waitingReason: 'input',
        detail,
      })
    }
    this.sessions.taskRuns.finishLatest(taskId, 'waiting', detail)
    this.schedule()
    return true
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
      .toSorted(compareQueuedTasks)
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
        if (this.mustReserveHumanSlot(task)) {
          const userTask = this.nextQueuedTask((candidate) => candidate.origin === 'user' && candidate.kind !== 'reminder')
          if (userTask === undefined) return
          await this.launch(userTask)
          continue
        }
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

  private nextQueuedTask(filter: (task: Task) => boolean = () => true): Task | undefined {
    const now = this.now().getTime()
    return this.tasks.list()
      .filter((task) => (
        task.status === 'queued'
        && !this.active.has(task.id)
        && (task.scheduledFor === undefined || new Date(task.scheduledFor).getTime() <= now)
        && filter(task)
      ))
      .toSorted(compareQueuedTasks)[0]
  }

  /** Keep one slot free for user work when automation could otherwise occupy every worker. */
  private mustReserveHumanSlot(task: Task): boolean {
    if (this.maxConcurrent <= 1 || task.origin !== 'automation' || task.kind === 'reminder') return false
    if (this.active.size < this.maxConcurrent - 1) return false
    const now = this.now().getTime()
    return this.tasks.list().some((candidate) => (
      candidate.origin === 'user'
      && candidate.kind !== 'reminder'
      && candidate.status === 'queued'
      && !this.active.has(candidate.id)
      && (candidate.scheduledFor === undefined || new Date(candidate.scheduledFor).getTime() <= now)
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
    const run = this.sessions.taskRuns.start({
      taskId: task.id,
      sessionId: workerSession.id,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
    })
    const active: ActiveTask = {
      taskId: task.id,
      workerSessionId: workerSession.id,
      runId: run.id,
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
    const sessionId = event.type === 'session.updated' ? event.session.id : event.sessionId
    this.sessions.taskRuns.heartbeatSession(sessionId, this.leaseMs)
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
    const currentTask = this.tasks.list().find((task) => task.id === taskId)
    const effects = this.taskEffectsForTask(taskId)
    const pendingEffects = effects.filter((effect) => (
      effect.status === 'pending_approval' || effect.status === 'queued' || effect.status === 'running'
    ))
    const failedEffects = effects.filter((effect) => (
      effect.status === 'failed' || effect.status === 'cancelled' || effect.status === 'unknown_effect'
    ))
    const succeededReceipts = effects
      .filter((effect) => effect.status === 'succeeded')
      .map((effect) => `action:${effect.id}:succeeded`)
    const pendingApproval = pendingEffects.find((effect) => effect.status === 'pending_approval' && effect.approvalId !== undefined)
    this.sessions.taskRuns.setStatus(active.runId, pendingEffects.length > 0 ? 'waiting' : 'completed')
    const result: TaskResultEnvelope = {
      outcome: pendingEffects.length > 0
        ? 'needs_review'
        : failedEffects.length > 0
          ? failedEffects.some((effect) => effect.status === 'unknown_effect') ? 'needs_review' : 'failed'
          : 'completed',
      summary: answer.text,
      artifacts: taskArtifacts(this.tasks.list().find((task) => task.id === taskId)),
      evidenceRefs: [`session:${active.workerSessionId}:event:${answer.eventId}`],
      limitations: failedEffects.flatMap((effect): string[] => effect.lastError === undefined ? [] : [effect.lastError]),
      externalEffectReceipts: [
        ...new Set([
          ...succeededReceipts,
          ...failedEffects.map((effect) => `action:${effect.id}:${effect.status}`),
        ]),
      ],
    }
    if (pendingEffects.length > 0) {
      if (currentTask?.status !== 'waiting' || currentTask.waitingReason !== 'approval') {
        if (currentTask !== undefined && pendingApproval?.approvalId !== undefined) {
          this.tasks.requestApproval(taskId, pendingApproval.approvalId, 'Waiting for a person to approve an external action.')
        } else {
          this.tasks.updateStatus(taskId, {
            status: 'waiting',
            waitingReason: 'review',
            detail: 'Waiting for an external action to finish.',
          })
        }
      }
      this.tasks.recordPendingResult(taskId, result)
    } else {
      this.tasks.recordResult(taskId, result)
    }
    const routineTask = currentTask?.presentation === 'routine' ? this.tasks.get(taskId) : undefined
    if (routineTask !== undefined) {
      this.sessions.routines.record(routineTask, result)
    } else {
      this.recordResultForRouter(active.workerSessionId, taskId, result)
      void this.projectTaskResult(taskId, active.workerSessionId, result, answer.eventId, pendingEffects.length > 0)
    }
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
    this.sessions.taskRuns.setStatus(active.runId, status === 'cancelled' ? 'cancelled' : 'failed', detail)
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
    if (current.presentation === 'routine') {
      this.sessions.routines.record(current, result)
    } else {
      this.recordResultForRouter(active.workerSessionId, taskId, result)
      if (status === 'failed') void this.projectTaskResult(taskId, active.workerSessionId, result)
    }
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
        taskId: task.id,
      },
    )
  }

  private recordResultForRouter(
    sessionId: string,
    taskId: string,
    result: TaskResultEnvelope,
  ): void {
    try {
      this.sessions.append(sessionId, [{
        type: 'task.result',
        data: { taskId, result },
        actor: { kind: 'agent', id: 'router' },
      }])
    } catch {
      // The durable Task result remains authoritative even if its coordination context cannot be appended.
    }
  }

  private async projectTaskResult(
    taskId: string,
    sessionId: string,
    result: TaskResultEnvelope,
    sessionEventId?: string,
    pendingEffect = false,
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
        ...(pendingEffect ? { taskPendingEffect: true } : {}),
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
    this.sessions.taskRuns.setStatus(active.runId, 'cancelled', 'Task requeued with new instructions.')
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
    this.sessions.taskRuns.setStatus(active.runId, 'cancelled', 'Task cancelled.')
    try {
      await this.agent.cancel(active.workerSessionId)
    } catch {
      this.removeActive(taskId)
      this.schedule()
    }
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


/** User work outranks reminders, which outrank automation. Stable within each lane by schedule and age. */
function compareQueuedTasks(left: Task, right: Task): number {
  const rankDelta = queueLane(left) - queueLane(right)
  if (rankDelta !== 0) return rankDelta
  const leftAt = left.scheduledFor ?? left.createdAt
  const rightAt = right.scheduledFor ?? right.createdAt
  return leftAt.localeCompare(rightAt)
}

function queueLane(task: Task): number {
  return task.origin === 'user' && task.kind !== 'reminder' ? 0 : task.kind === 'reminder' ? 1 : 2
}
