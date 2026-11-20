import { randomUUID } from 'node:crypto'
import type {
  AttachmentDescriptor,
  Task,
  TaskContinuationResult,
} from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { TaskService } from './task-service'
import type { TaskRouterDecision, TaskRouterDecisionEngine } from './task-router-coordinator'

type TaskConversationTasks = Pick<TaskService, 'get' | 'assignSession' | 'reroute' | 'updateStatus'>
type TaskConversationSessions = Pick<SessionStore, 'append' | 'createSession' | 'read'>

/**
 * A Task owns one conversation log: its Session. A message is appended once,
 * then the Host chooses exactly one authority for it. Worker dispatch and a
 * Router coordination reply are mutually exclusive, so a Task never has two
 * models answering the same message.
 */
export class TaskConversationService {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly tasks: TaskConversationTasks,
    private readonly sessions: TaskConversationSessions,
    private readonly router: TaskRouterDecisionEngine,
  ) {}

  continueTask(
    taskId: string,
    text: string,
    attachments: AttachmentDescriptor[] = [],
  ): Promise<TaskContinuationResult> {
    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() => this.continueTaskSerially(taskId, text, attachments))
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(taskId, tail)
    return run.finally(() => {
      if (this.queues.get(taskId) === tail) this.queues.delete(taskId)
    })
  }

  private async continueTaskSerially(
    taskId: string,
    text: string,
    attachments: AttachmentDescriptor[],
  ): Promise<TaskContinuationResult> {
    const task = this.tasks.get(taskId)
    if (task.kind === 'reminder') throw new Error('A reminder is not an agent Task')
    if (task.status === 'cancelled') throw new Error('A cancelled Task cannot receive new messages')
    const normalized = text.trim()
    if (normalized.length === 0) throw new Error('Task message cannot be empty')

    const sessionId = task.sessionId ?? this.createSession(task)
    this.sessions.append(sessionId, [{
      type: 'agent.message',
      data: {
        message: {
          role: 'user',
          content: normalized,
          timestamp: Date.now(),
        },
        attachments,
        taskMessageId: randomUUID(),
        taskCommand: true,
      },
      actor: { kind: 'user', id: 'desktop-user' },
    }])

    let decision: TaskRouterDecision
    try {
      decision = await this.router.decide({
        task,
        text: normalized,
        attachments,
        recentEvents: this.sessions.read(sessionId),
        ...(task.workingDirectory === undefined ? {} : { workingDirectory: task.workingDirectory }),
        now: new Date(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch (error) {
      this.sessions.append(sessionId, [{
        type: 'task.router-fallback',
        data: {
          taskId: task.id,
          error: errorMessage(error),
          reason: 'Task Router failed; Worker receives the message.',
        },
        actor: { kind: 'system', id: 'task-router' },
      }])
      return this.dispatchToWorker(task.id, normalized)
    }

    if (decision.action === 'delegate') {
      return this.dispatchToWorker(task.id, normalized)
    }

    if (decision.action === 'cancel') {
      if (task.status === 'completed') {
        const reply = this.appendRouterReply(
          sessionId,
          task.id,
          cancellationUnavailableText(normalized),
          decision.memoryRefs,
        )
        return { task: this.tasks.get(task.id), delivery: 'router', replyMessageId: reply.eventId }
      }
      const reason = decision.reason?.trim() || 'Cancelled from the Task conversation.'
      const updated = this.tasks.updateStatus(task.id, { status: 'cancelled', detail: reason })
      const reply = this.appendRouterReply(sessionId, task.id, decision.message, decision.memoryRefs)
      return { task: updated, delivery: 'router', replyMessageId: reply.eventId }
    }

    const reply = this.appendRouterReply(sessionId, task.id, decision.text, decision.memoryRefs)
    return { task: this.tasks.get(task.id), delivery: 'router', replyMessageId: reply.eventId }
  }

  private dispatchToWorker(
    taskId: string,
    instruction: string,
  ): TaskContinuationResult {
    const updated = this.tasks.reroute(taskId, instruction)
    return { task: updated, delivery: 'worker' }
  }

  private createSession(task: Task): string {
    const session = this.sessions.createSession(task.title)
    this.tasks.assignSession(task.id, session.id)
    return session.id
  }

  private appendRouterReply(
    sessionId: string,
    taskId: string,
    text: string,
    memoryRefs: string[],
  ): ReturnType<SessionStore['append']>[number] {
    const [reply] = this.sessions.append(sessionId, [{
      type: 'agent.message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
        },
        actorRole: 'router',
        taskId,
        ...(memoryRefs.length === 0 ? {} : { memoryRefs }),
      },
      actor: { kind: 'agent', id: 'router' },
    }])
    if (reply === undefined) throw new Error('Task Router reply was not persisted')
    return reply
  }
}

function cancellationUnavailableText(text: string): string {
  return /[\u3400-\u9fff]/u.test(text)
    ? '这个任务已经完成，不需要再停止。'
    : 'This Task is already complete, so there is nothing to cancel.'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
