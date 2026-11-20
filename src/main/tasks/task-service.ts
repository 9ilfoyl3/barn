import type {
  CreateTaskInput,
  Task,
  TaskLiveEvent,
  TaskResultEnvelope,
  TaskStatusUpdate,
  UpdateRoutineInput,
} from '../../shared/models'
import { TaskStore } from './task-store'

/** Application-facing Task commands with change events for the Desktop UI and future background runtime. */
export class TaskService {
  private readonly listeners = new Set<(event: TaskLiveEvent) => void>()

  constructor(private readonly store: TaskStore) {}

  list(): Task[] {
    return this.store.list()
  }

  get(taskId: string): Task {
    return this.store.get(taskId)
  }

  create(input: CreateTaskInput): Task {
    const task = this.store.create(input)
    this.emit(task)
    return task
  }

  updateStatus(taskId: string, update: TaskStatusUpdate): Task {
    const task = this.store.updateStatus(taskId, update)
    this.emit(task)
    return task
  }

  requestApproval(taskId: string, approvalId: string, detail: string): Task {
    const task = this.store.requestApproval(taskId, approvalId, detail)
    this.emit(task)
    return task
  }

  updatePrompt(taskId: string, prompt: string): Task {
    const task = this.store.updatePrompt(taskId, prompt)
    this.emit(task)
    return task
  }

  reroute(taskId: string, instruction: string): Task {
    const task = this.store.reroute(taskId, instruction)
    this.emit(task)
    return task
  }

  recordResult(taskId: string, result: TaskResultEnvelope): Task {
    const task = this.store.recordResult(taskId, result)
    this.emit(task)
    return task
  }

  rescheduleReminder(taskId: string, scheduledFor: string): Task {
    const task = this.store.rescheduleReminder(taskId, scheduledFor)
    this.emit(task)
    return task
  }

  updateRoutine(taskId: string, input: UpdateRoutineInput): Task {
    const task = this.store.updateRoutine(taskId, input)
    this.emit(task)
    return task
  }

  assignSession(taskId: string, sessionId: string | null): Task {
    const task = this.store.assignSession(taskId, sessionId)
    this.emit(task)
    return task
  }

  onEvent(listener: (event: TaskLiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(task: Task): void {
    const event: TaskLiveEvent = { type: 'task.updated', task }
    for (const listener of this.listeners) listener(event)
  }
}
