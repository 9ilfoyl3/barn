import { randomUUID } from 'node:crypto'
import type { AttachmentDescriptor, Task } from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { TaskService } from './task-service'

type TaskConversationTasks = Pick<TaskService, 'get' | 'assignSession' | 'reroute'>
type TaskConversationSessions = Pick<SessionStore, 'append' | 'createSession'>

/**
 * A Task owns one conversation log: its Session. A person's message is
 * appended once, then the Router and Worker consume the same message as
 * participants. The Principal Thread receives only Task progress and result
 * projections, never the Task's own user or agent turns.
 */
export class TaskConversationService {
  constructor(
    private readonly tasks: TaskConversationTasks,
    private readonly sessions: TaskConversationSessions,
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
        taskMessageId: randomUUID(),
        taskCommand: true,
      },
      actor: { kind: 'user', id: 'desktop-user' },
    }])
    return this.tasks.reroute(task.id, normalized)
  }

  private createSession(task: Task): string {
    const session = this.sessions.createSession(task.title)
    this.tasks.assignSession(task.id, session.id)
    return session.id
  }
}
