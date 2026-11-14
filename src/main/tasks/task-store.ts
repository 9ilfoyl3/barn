import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CreateTaskInput,
  Task,
  TaskOrigin,
  TaskStatus,
  TaskStatusUpdate,
  TaskWaitingReason,
} from '../../shared/models'

const ACTIVE_STATUSES: readonly TaskStatus[] = ['waiting', 'running', 'queued', 'proposed']
const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']
const STATUSES: readonly TaskStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES]
const ORIGINS: readonly TaskOrigin[] = ['user', 'automation']
const WAITING_REASONS: readonly TaskWaitingReason[] = ['input', 'approval']
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  proposed: ['queued', 'cancelled'],
  queued: ['running', 'waiting', 'failed', 'cancelled'],
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['queued', 'running', 'completed', 'failed', 'cancelled'],
  failed: ['queued', 'cancelled'],
  completed: [],
  cancelled: [],
}

interface TaskRow {
  id: string
  title: string
  status: string
  origin: string
  session_id: string | null
  waiting_reason: string | null
  detail: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

/** Durable work items are independent of the Session that happens to execute one run. */
export class TaskStore {
  constructor(private readonly database: DatabaseSync) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        origin TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        waiting_reason TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS tasks_status_updated
        ON tasks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_session
        ON tasks(session_id);
    `)
  }

  create(input: CreateTaskInput, taskId: string = randomUUID()): Task {
    if (taskId.trim().length === 0) throw new Error('Task id cannot be empty')
    const title = requireTitle(input.title)
    if (!ORIGINS.includes(input.origin)) throw new Error(`Unknown task origin: ${input.origin}`)
    const status = input.status ?? 'queued'
    if (status !== 'proposed' && status !== 'queued') {
      throw new Error(`A task can only be created as proposed or queued, not ${status}`)
    }
    if (input.sessionId !== undefined) this.requireSession(input.sessionId)

    const now = new Date().toISOString()
    const task: Task = {
      id: taskId,
      title,
      status,
      origin: input.origin,
      createdAt: now,
      updatedAt: now,
    }
    if (input.sessionId !== undefined) task.sessionId = input.sessionId
    this.database.prepare(`
      INSERT INTO tasks (
        id, title, status, origin, session_id,
        waiting_reason, detail, created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
    `).run(task.id, task.title, task.status, task.origin, task.sessionId ?? null, now, now)
    return task
  }

  get(taskId: string): Task {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (row === undefined) throw new Error(`Unknown task: ${taskId}`)
    return toTask(row)
  }

  list(): Task[] {
    const rows = this.database.prepare(`
      SELECT * FROM tasks
      ORDER BY
        CASE status
          WHEN 'waiting' THEN 0
          WHEN 'running' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'proposed' THEN 3
          ELSE 4
        END,
        updated_at DESC,
        created_at DESC,
        id DESC
    `).all() as unknown as TaskRow[]
    return rows.map(toTask)
  }

  updateStatus(taskId: string, update: TaskStatusUpdate): Task {
    const current = this.get(taskId)
    if (!STATUSES.includes(update.status)) throw new Error(`Unknown task status: ${update.status}`)
    if (update.status !== current.status && !TRANSITIONS[current.status].includes(update.status)) {
      throw new Error(`Invalid task transition: ${current.status} -> ${update.status}`)
    }
    if (update.status === 'waiting' && update.waitingReason === undefined) {
      throw new Error('A waiting task requires a waiting reason')
    }
    if (update.status !== 'waiting' && update.waitingReason !== undefined) {
      throw new Error('Only a waiting task can have a waiting reason')
    }
    if (update.waitingReason !== undefined && !WAITING_REASONS.includes(update.waitingReason)) {
      throw new Error(`Unknown waiting reason: ${update.waitingReason}`)
    }

    const now = new Date().toISOString()
    const waitingReason = update.status === 'waiting' ? update.waitingReason ?? null : null
    const detail = update.detail === undefined ? current.detail ?? null : normalizeDetail(update.detail)
    const startedAt = update.status === 'running'
      ? current.startedAt ?? now
      : current.startedAt ?? null
    const finishedAt = TERMINAL_STATUSES.includes(update.status)
      ? current.finishedAt ?? now
      : null

    this.database.prepare(`
      UPDATE tasks
      SET status = ?, waiting_reason = ?, detail = ?, updated_at = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(update.status, waitingReason, detail, now, startedAt, finishedAt, taskId)
    return this.get(taskId)
  }

  assignSession(taskId: string, sessionId: string | null): Task {
    this.get(taskId)
    if (sessionId !== null) this.requireSession(sessionId)
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?
    `).run(sessionId, now, taskId)
    return this.get(taskId)
  }

  /** Running work cannot survive a process restart; return it to the queue for the next runtime. */
  recoverInterruptedTasks(): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE tasks
      SET status = 'queued', waiting_reason = NULL, detail = 'Recovered after restart', updated_at = ?, finished_at = NULL
      WHERE status = 'running'
    `).run(now)
    return Number(result.changes)
  }

  private requireSession(sessionId: string): void {
    const row = this.database.prepare('SELECT 1 AS found FROM sessions WHERE id = ?').get(sessionId) as { found: number } | undefined
    if (row === undefined) throw new Error(`Unknown session: ${sessionId}`)
  }
}

/** Whether a task still represents work that can progress. */
export function isActiveTask(task: Pick<Task, 'status'>): boolean {
  return ACTIVE_STATUSES.includes(task.status)
}

function toTask(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    title: row.title,
    status: requireStatus(row.status),
    origin: requireOrigin(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.session_id !== null) task.sessionId = row.session_id
  if (row.waiting_reason !== null) task.waitingReason = requireWaitingReason(row.waiting_reason)
  if (row.detail !== null) task.detail = row.detail
  if (row.started_at !== null) task.startedAt = row.started_at
  if (row.finished_at !== null) task.finishedAt = row.finished_at
  return task
}

function requireTitle(value: string): string {
  const title = value.trim()
  if (title.length === 0) throw new Error('Task title cannot be empty')
  if (title.length > 200) throw new Error('Task title must be 200 characters or fewer')
  return title
}

function normalizeDetail(value: string | undefined): string | null {
  if (value === undefined) return null
  const detail = value.trim()
  if (detail.length === 0) return null
  if (detail.length > 2_000) throw new Error('Task detail must be 2,000 characters or fewer')
  return detail
}

function requireStatus(value: string): TaskStatus {
  if (!STATUSES.includes(value as TaskStatus)) throw new Error(`Unknown task status in storage: ${value}`)
  return value as TaskStatus
}

function requireOrigin(value: string): TaskOrigin {
  if (!ORIGINS.includes(value as TaskOrigin)) throw new Error(`Unknown task origin in storage: ${value}`)
  return value as TaskOrigin
}

function requireWaitingReason(value: string): TaskWaitingReason {
  if (!WAITING_REASONS.includes(value as TaskWaitingReason)) {
    throw new Error(`Unknown waiting reason in storage: ${value}`)
  }
  return value as TaskWaitingReason
}
