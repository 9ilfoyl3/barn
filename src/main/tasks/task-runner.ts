import type { AgentPromptOptions, AttachmentDescriptor, SessionLiveEvent, Task } from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { ThreadService } from '../threads/thread-service'
import type { TaskService } from './task-service'

export interface TaskRunnerOptions {
  maxConcurrent?: number
  now?: () => Date
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
  sessionId: string
  cancelRequested: boolean
}

/** Runs queued Tasks through AgentService and projects run outcomes back into durable Task state. */
export class TaskRunner {
  private readonly maxConcurrent: number
  private readonly now: () => Date
  private readonly active = new Map<string, ActiveTask>()
  private readonly activeSessions = new Map<string, string>()
  private disposers: Array<() => void> = []
  private scheduled: NodeJS.Immediate | undefined
  private wakeTimer: NodeJS.Timeout | undefined
  private draining = false
  private started = false

  constructor(
    private readonly agent: TaskAgent,
    private readonly tasks: Pick<TaskService, 'list' | 'updateStatus' | 'assignSession' | 'onEvent'>,
    private readonly sessions: Pick<SessionStore, 'createSession' | 'getSession'>,
    options: TaskRunnerOptions = {},
    private readonly threads?: Pick<ThreadService, 'appendMessage'>,
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.disposers.push(
      this.tasks.onEvent((event) => {
        const task = event.task
        if (task.status === 'queued') {
          this.schedule()
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
    const future = this.tasks.list()
      .filter((task) => task.status === 'queued' && !this.active.has(task.id))
      .map((task) => ({ task, dueAt: task.scheduledFor === undefined ? now : new Date(task.scheduledFor).getTime() }))
      .filter((entry) => Number.isFinite(entry.dueAt) && entry.dueAt > now)
      .toSorted((left, right) => left.dueAt - right.dueAt)[0]
    if (future !== undefined) {
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
      this.threads?.appendMessage({
        clientMessageId: `task-reminder:${task.id}`,
        role: 'assistant',
        content: `Reminder: ${task.visiblePrompt ?? task.title}`,
        metadata: {
          taskId: task.id,
          resultCard: {
            version: 1,
            kind: 'task',
            title: task.title,
            description: 'Scheduled reminder delivered.',
            provider: 'Barn',
            status: 'Reminder',
            meta: task.scheduledFor === undefined ? 'Due now' : `Scheduled for ${task.scheduledFor}`,
          },
        },
        sourceRefs: [`task:${task.id}`],
      })
      this.tasks.updateStatus(task.id, { status: 'completed', detail: '' })
      this.schedule()
      return
    }
    const session = task.sessionId === undefined
      ? this.sessions.createSession(task.title)
      : this.sessions.getSession(task.sessionId)
    const active: ActiveTask = { taskId: task.id, sessionId: session.id, cancelRequested: false }
    this.active.set(task.id, active)
    this.activeSessions.set(session.id, task.id)
    try {
      this.tasks.assignSession(task.id, session.id)
      this.tasks.updateStatus(task.id, { status: 'running', detail: 'Task execution started.' })
      await this.agent.prompt(
        session.id,
        task.prompt!,
        task.attachments ?? [],
        task.workingDirectory,
        task.visiblePrompt,
        {
          projectUserMessage: false,
          visibleMetadata: { taskId: task.id },
          clientMessageIdPrefix: `task-assistant:${task.id}`,
        },
      )
    } catch (error) {
      this.removeActive(task.id)
      const current = this.tasks.list().find((candidate) => candidate.id === task.id)
      if (current !== undefined && current.status !== 'completed' && current.status !== 'cancelled') {
        this.tasks.updateStatus(task.id, {
          status: 'failed',
          detail: errorMessage(error),
        })
      }
      this.schedule()
    }
  }

  private handleRunEvent(event: SessionLiveEvent): void {
    if (event.type === 'session.updated' && event.session.status === 'failed') {
      const taskId = this.activeSessions.get(event.session.id)
      if (taskId === undefined) return
      this.removeActive(taskId)
      this.updateIfActive(taskId, { status: 'failed', detail: 'The Agent Worker stopped unexpectedly.' })
      this.schedule()
      return
    }
    if (event.type !== 'run.status') return
    const taskId = this.activeSessions.get(event.sessionId)
    if (taskId === undefined) return
    const active = this.active.get(taskId)
    if (active === undefined) return

    if (event.status === 'running') return
    this.removeActive(taskId)
    if (event.status === 'failed') {
      this.updateIfActive(taskId, {
        status: 'failed',
        detail: event.error ?? 'Task execution failed.',
      })
    } else if (event.status === 'cancelled' || active.cancelRequested) {
      this.updateIfActive(taskId, {
        status: 'cancelled',
        detail: event.error ?? 'Task cancelled.',
      })
    } else {
      this.updateIfActive(taskId, { status: 'completed', detail: '' })
    }
    this.schedule()
  }

  private async cancelActive(taskId: string): Promise<void> {
    const active = this.active.get(taskId)
    if (active === undefined) return
    active.cancelRequested = true
    try {
      await this.agent.cancel(active.sessionId)
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
    if (this.activeSessions.get(active.sessionId) === taskId) this.activeSessions.delete(active.sessionId)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
