import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AesGcmEventCipher } from '../session/event-cipher'
import type {
  AttachmentDescriptor,
  CreateTaskInput,
  Task,
  TaskOrigin,
  TaskStatus,
  TaskStatusUpdate,
  TaskWaitingReason,
  RoutineRecurrence,
  UpdateRoutineInput,
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
  kind: string
  scheduled_for: string | null
  recurrence: string | null
  timezone: string | null
  session_id: string | null
  approval_id: string | null
  prompt_ciphertext: Uint8Array | null
  prompt_nonce: Uint8Array | null
  prompt_tag: Uint8Array | null
  visible_prompt_ciphertext: Uint8Array | null
  visible_prompt_nonce: Uint8Array | null
  visible_prompt_tag: Uint8Array | null
  working_directory: string | null
  attachments_ciphertext: Uint8Array | null
  attachments_nonce: Uint8Array | null
  attachments_tag: Uint8Array | null
  waiting_reason: string | null
  detail: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

/** Durable work items are independent of the Session that happens to execute one run. */
export class TaskStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        origin TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'work',
        scheduled_for TEXT,
        recurrence TEXT,
        timezone TEXT,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        approval_id TEXT,
        prompt_ciphertext BLOB,
        prompt_nonce BLOB,
        prompt_tag BLOB,
        visible_prompt_ciphertext BLOB,
        visible_prompt_nonce BLOB,
        visible_prompt_tag BLOB,
        working_directory TEXT,
        attachments_ciphertext BLOB,
        attachments_nonce BLOB,
        attachments_tag BLOB,
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
    this.ensureOptionalColumns()
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
      kind: input.kind ?? 'work',
      createdAt: now,
      updatedAt: now,
    }
    if (input.sessionId !== undefined) task.sessionId = input.sessionId
    if (input.scheduledFor !== undefined) task.scheduledFor = normalizeScheduledFor(input.scheduledFor)
    if (input.recurrence !== undefined) task.recurrence = input.recurrence
    if (input.timezone !== undefined) task.timezone = normalizeTimezone(input.timezone)
    if (input.prompt !== undefined) task.prompt = normalizePrompt(input.prompt)
    if (input.visiblePrompt !== undefined) task.visiblePrompt = normalizePrompt(input.visiblePrompt)
    if (input.workingDirectory !== undefined) task.workingDirectory = normalizeWorkingDirectory(input.workingDirectory)
    if (input.attachments !== undefined) task.attachments = normalizeAttachments(input.attachments)
    const encryptedPrompt = task.prompt === undefined
      ? undefined
      : this.cipher.encrypt(task.prompt, promptAssociatedData(task.id))
    const encryptedVisiblePrompt = task.visiblePrompt === undefined
      ? undefined
      : this.cipher.encrypt(task.visiblePrompt, visiblePromptAssociatedData(task.id))
    const encryptedAttachments = task.attachments === undefined
      ? undefined
      : this.cipher.encrypt(JSON.stringify(task.attachments), attachmentsAssociatedData(task.id))
    this.database.prepare(`
      INSERT INTO tasks (
        id, title, status, origin, kind, scheduled_for, recurrence, timezone, session_id, approval_id,
        prompt_ciphertext, prompt_nonce, prompt_tag,
        visible_prompt_ciphertext, visible_prompt_nonce, visible_prompt_tag,
        working_directory, attachments_ciphertext, attachments_nonce, attachments_tag,
        waiting_reason, detail, created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
    `).run(
      task.id,
      task.title,
      task.status,
      task.origin,
      task.kind ?? 'work',
      task.scheduledFor ?? null,
      task.recurrence ?? null,
      task.timezone ?? null,
      task.sessionId ?? null,
      encryptedPrompt?.ciphertext ?? null,
      encryptedPrompt?.nonce ?? null,
      encryptedPrompt?.tag ?? null,
      encryptedVisiblePrompt?.ciphertext ?? null,
      encryptedVisiblePrompt?.nonce ?? null,
      encryptedVisiblePrompt?.tag ?? null,
      task.workingDirectory ?? null,
      encryptedAttachments?.ciphertext ?? null,
      encryptedAttachments?.nonce ?? null,
      encryptedAttachments?.tag ?? null,
      now,
      now,
    )
    return task
  }

  get(taskId: string): Task {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (row === undefined) throw new Error(`Unknown task: ${taskId}`)
    return this.toTask(row)
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
    return rows.map((row) => this.toTask(row))
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
    const approvalId = update.status === 'waiting' ? current.approvalId ?? null : null
    const detail = update.detail === undefined ? current.detail ?? null : normalizeDetail(update.detail)
    const startedAt = update.status === 'running'
      ? current.startedAt ?? now
      : current.startedAt ?? null
    const finishedAt = TERMINAL_STATUSES.includes(update.status)
      ? current.finishedAt ?? now
      : null

    this.database.prepare(`
      UPDATE tasks
      SET status = ?, approval_id = ?, waiting_reason = ?, detail = ?, updated_at = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(update.status, approvalId, waitingReason, detail, now, startedAt, finishedAt, taskId)
    return this.get(taskId)
  }

  requestApproval(taskId: string, approvalId: string, detail: string): Task {
    const task = this.get(taskId)
    if (!['proposed', 'queued', 'running', 'waiting', 'failed'].includes(task.status)) {
      throw new Error(`Task cannot request approval while it is ${task.status}`)
    }
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks
      SET status = 'waiting', approval_id = ?, waiting_reason = 'approval', detail = ?, updated_at = ?, finished_at = NULL
      WHERE id = ?
    `).run(approvalId, normalizeDetail(detail), now, taskId)
    return this.get(taskId)
  }

  /** Requeue an existing Task with additional instructions while keeping its transcript. */
  reroute(taskId: string, instruction: string): Task {
    const task = this.get(taskId)
    if (task.status === 'cancelled') {
      throw new Error(`A ${task.status} task cannot be rerouted`)
    }
    const normalized = normalizePrompt(instruction)
    const prompt = task.prompt === undefined ? normalized : `${task.prompt}\n\nAdditional instruction:\n${normalized}`
    const visiblePrompt = normalized
    const encryptedPrompt = this.cipher.encrypt(prompt, promptAssociatedData(taskId))
    const encryptedVisible = this.cipher.encrypt(visiblePrompt, visiblePromptAssociatedData(taskId))
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks
      SET prompt_ciphertext = ?, prompt_nonce = ?, prompt_tag = ?,
          visible_prompt_ciphertext = ?, visible_prompt_nonce = ?, visible_prompt_tag = ?,
          status = 'queued', waiting_reason = NULL, approval_id = NULL,
          detail = 'New instructions added; task requeued.', updated_at = ?, started_at = NULL, finished_at = NULL
      WHERE id = ?
    `).run(
      encryptedPrompt.ciphertext,
      encryptedPrompt.nonce,
      encryptedPrompt.tag,
      encryptedVisible.ciphertext,
      encryptedVisible.nonce,
      encryptedVisible.tag,
      now,
      taskId,
    )
    return this.get(taskId)
  }

  updatePrompt(taskId: string, value: string): Task {
    const task = this.get(taskId)
    if (!['proposed', 'queued', 'waiting', 'failed'].includes(task.status)) {
      throw new Error(`Task instructions cannot change while the task is ${task.status}`)
    }
    const prompt = normalizePrompt(value)
    const encrypted = this.cipher.encrypt(prompt, promptAssociatedData(taskId))
    const visible = this.cipher.encrypt(prompt, visiblePromptAssociatedData(taskId))
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks
      SET prompt_ciphertext = ?, prompt_nonce = ?, prompt_tag = ?,
          visible_prompt_ciphertext = ?, visible_prompt_nonce = ?, visible_prompt_tag = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      visible.ciphertext,
      visible.nonce,
      visible.tag,
      now,
      taskId,
    )
    return this.get(taskId)
  }

  updateRoutine(taskId: string, input: UpdateRoutineInput): Task {
    const task = this.get(taskId)
    if (task.kind !== 'reminder') throw new Error('Only reminder routines can be updated as routines')
    const title = requireTitle(input.title)
    const text = normalizePrompt(input.text)
    const scheduledFor = normalizeScheduledFor(input.scheduledFor)
    const recurrence = requireRecurrence(input.recurrence)
    const timezone = normalizeTimezone(input.timezone)
    const encryptedPrompt = this.cipher.encrypt(text, promptAssociatedData(taskId))
    const encryptedVisible = this.cipher.encrypt(text, visiblePromptAssociatedData(taskId))
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks
      SET title = ?, status = 'queued', scheduled_for = ?, recurrence = ?, timezone = ?,
          prompt_ciphertext = ?, prompt_nonce = ?, prompt_tag = ?,
          visible_prompt_ciphertext = ?, visible_prompt_nonce = ?, visible_prompt_tag = ?,
          detail = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      title,
      scheduledFor,
      recurrence,
      timezone,
      encryptedPrompt.ciphertext,
      encryptedPrompt.nonce,
      encryptedPrompt.tag,
      encryptedVisible.ciphertext,
      encryptedVisible.nonce,
      encryptedVisible.tag,
      now,
      taskId,
    )
    return this.get(taskId)
  }

  rescheduleReminder(taskId: string, scheduledFor: string): Task {
    const task = this.get(taskId)
    if (task.kind !== 'reminder') throw new Error('Only reminder routines can be rescheduled')
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks
      SET status = 'queued', scheduled_for = ?, detail = NULL,
          started_at = NULL, finished_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(normalizeScheduledFor(scheduledFor), now, taskId)
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
      SET status = 'queued', session_id = NULL, waiting_reason = NULL, detail = 'Recovered after restart', updated_at = ?, finished_at = NULL
      WHERE status = 'running'
    `).run(now)
    return Number(result.changes)
  }

  private toTask(row: TaskRow): Task {
    const task: Task = {
      id: row.id,
      title: row.title,
      status: requireStatus(row.status),
      origin: requireOrigin(row.origin),
      kind: row.kind === 'reminder' ? 'reminder' : 'work',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.scheduled_for !== null) task.scheduledFor = row.scheduled_for
    if (row.recurrence !== null) task.recurrence = requireRecurrence(row.recurrence)
    if (row.timezone !== null) task.timezone = row.timezone
    if (row.session_id !== null) task.sessionId = row.session_id
    if (row.approval_id !== null) task.approvalId = row.approval_id
    if (row.working_directory !== null) task.workingDirectory = row.working_directory
    if (row.waiting_reason !== null) task.waitingReason = requireWaitingReason(row.waiting_reason)
    if (row.detail !== null) task.detail = row.detail
    if (row.started_at !== null) task.startedAt = row.started_at
    if (row.finished_at !== null) task.finishedAt = row.finished_at
    const promptFields = [row.prompt_ciphertext, row.prompt_nonce, row.prompt_tag]
    if (promptFields.some((field) => field !== null)) {
      if (promptFields.some((field) => field === null)) throw new Error(`Incomplete encrypted prompt for task: ${row.id}`)
      task.prompt = this.cipher.decrypt({
        ciphertext: row.prompt_ciphertext!,
        nonce: row.prompt_nonce!,
        tag: row.prompt_tag!,
      }, promptAssociatedData(row.id)) as string
    }
    const visibleFields = [row.visible_prompt_ciphertext, row.visible_prompt_nonce, row.visible_prompt_tag]
    if (visibleFields.some((field) => field !== null)) {
      if (visibleFields.some((field) => field === null)) throw new Error(`Incomplete encrypted visible prompt for task: ${row.id}`)
      task.visiblePrompt = this.cipher.decrypt({
        ciphertext: row.visible_prompt_ciphertext!,
        nonce: row.visible_prompt_nonce!,
        tag: row.visible_prompt_tag!,
      }, visiblePromptAssociatedData(row.id)) as string
    }
    const attachmentFields = [row.attachments_ciphertext, row.attachments_nonce, row.attachments_tag]
    if (attachmentFields.some((field) => field !== null)) {
      if (attachmentFields.some((field) => field === null)) throw new Error(`Incomplete encrypted attachments for task: ${row.id}`)
      const raw = this.cipher.decrypt({
        ciphertext: row.attachments_ciphertext!,
        nonce: row.attachments_nonce!,
        tag: row.attachments_tag!,
      }, attachmentsAssociatedData(row.id)) as string
      task.attachments = normalizeAttachments(JSON.parse(raw) as AttachmentDescriptor[])
    }
    if (task.kind === 'reminder' && task.recurrence === undefined) {
      task.recurrence = inferLegacyRecurrence(`${task.title} ${task.visiblePrompt ?? ''} ${task.prompt ?? ''}`)
    }
    return task
  }

  /** Add columns introduced after the initial Task schema. */
  private ensureOptionalColumns(): void {
    const columns = new Set((this.database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
      .map((column) => column.name))
    const additions = [
      ['approval_id', 'TEXT'],
      ['prompt_ciphertext', 'BLOB'],
      ['prompt_nonce', 'BLOB'],
      ['prompt_tag', 'BLOB'],
      ['visible_prompt_ciphertext', 'BLOB'],
      ['visible_prompt_nonce', 'BLOB'],
      ['visible_prompt_tag', 'BLOB'],
      ['working_directory', 'TEXT'],
      ['attachments_ciphertext', 'BLOB'],
      ['attachments_nonce', 'BLOB'],
      ['attachments_tag', 'BLOB'],
      ['kind', "TEXT NOT NULL DEFAULT 'work'"],
      ['scheduled_for', 'TEXT'],
      ['recurrence', 'TEXT'],
      ['timezone', 'TEXT'],
    ] as const
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`)
    }
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

function inferLegacyRecurrence(value: string): RoutineRecurrence {
  if (/(每天|每日|\bdaily\b|every\s+day)/iu.test(value)) return 'daily'
  if (/(工作日|\bweekdays?\b)/iu.test(value)) return 'weekdays'
  if (/(每周|\bweekly\b|every\s+week)/iu.test(value)) return 'weekly'
  return 'none'
}

function requireRecurrence(value: string): RoutineRecurrence {
  if (value === 'none' || value === 'daily' || value === 'weekdays' || value === 'weekly') return value
  throw new Error(`Unknown routine recurrence: ${value}`)
}

function normalizeTimezone(value: string): string {
  const timezone = value.trim()
  if (timezone.length === 0 || timezone.length > 100) throw new Error('Routine timezone is invalid')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new Error(`Unknown routine timezone: ${timezone}`)
  }
  return timezone
}

function requireTitle(value: string): string {
  const title = value.trim()
  if (title.length === 0) throw new Error('Task title cannot be empty')
  if (title.length > 200) throw new Error('Task title must be 200 characters or fewer')
  return title
}

function normalizePrompt(value: string): string {
  const prompt = value.trim()
  if (prompt.length === 0) throw new Error('Task prompt cannot be empty')
  if (prompt.length > 2_000_000) throw new Error('Task prompt must be 2,000,000 characters or fewer')
  return prompt
}

function promptAssociatedData(taskId: string): string {
  return `task:${taskId}:prompt`
}

function visiblePromptAssociatedData(taskId: string): string {
  return `task:${taskId}:visible-prompt`
}

function attachmentsAssociatedData(taskId: string): string {
  return `task:${taskId}:attachments`
}

function normalizeScheduledFor(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Task scheduled time is invalid')
  return date.toISOString()
}

function normalizeWorkingDirectory(value: string): string {
  const directory = value.trim()
  if (directory.length === 0) throw new Error('Task working directory cannot be empty')
  if (directory.length > 4_000) throw new Error('Task working directory must be 4,000 characters or fewer')
  return directory
}

function normalizeAttachments(value: AttachmentDescriptor[]): AttachmentDescriptor[] {
  if (value.length > 50) throw new Error('A task can include at most 50 attachments')
  return value.map((attachment) => {
    const name = attachment.name.trim()
    const path = attachment.path.trim()
    if (name.length === 0 || name.length > 500) throw new Error('Task attachment name is invalid')
    if (path.length === 0 || path.length > 4_000) throw new Error('Task attachment path is invalid')
    if (!Number.isInteger(attachment.size) || attachment.size < 0) throw new Error('Task attachment size is invalid')
    return {
      name,
      path,
      size: attachment.size,
      ...(attachment.kind === 'file' || attachment.kind === 'directory' ? { kind: attachment.kind } : {}),
    }
  })
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
