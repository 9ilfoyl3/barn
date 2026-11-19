import { randomUUID } from 'node:crypto'
import type { AttachmentDescriptor, Task } from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { ThreadService } from '../threads/thread-service'
import type { TaskService } from './task-service'

type TaskConversationTasks = Pick<TaskService, 'get' | 'assignSession' | 'reroute'>
type TaskConversationSessions = Pick<SessionStore, 'append' | 'createSession'>
type TaskConversationThreads = Pick<ThreadService, 'appendMessage'>

/**
 * A person's message in a Task is admitted to both sides of the Task:
 * the Router's Principal Thread and the Worker's Session. The Worker runs
 * through the normal TaskRunner queue, so progress and the final result keep
 * their existing Task and Router projections.
 */
export class TaskConversationService {
  constructor(
    private readonly tasks: TaskConversationTasks,
    private readonly sessions: TaskConversationSessions,
    private readonly threads: TaskConversationThreads,
  ) {}

  continueTask(taskId: string, text: string, attachments: AttachmentDescriptor[] = []): Task {
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
      },
      actor: { kind: 'user', id: 'desktop-user' },
    }])
    this.threads.appendMessage({
      clientMessageId: `task-message:${task.id}:${randomUUID()}`,
      role: 'user',
      content: normalized,
      metadata: {
        taskId: task.id,
        sessionId,
        taskMessage: true,
        attachmentNames: attachments.map((attachment) => attachment.name),
        ...(attachments.length === 0 ? {} : { attachments }),
      },
      sourceRefs: [`task:${task.id}`, `session:${sessionId}`],
    })
    return this.tasks.reroute(task.id, normalized)
  }

  private createSession(task: Task): string {
    const session = this.sessions.createSession(task.title)
    this.tasks.assignSession(task.id, session.id)
    return session.id
  }
}
