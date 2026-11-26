import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AesGcmEventCipher } from '../session/event-cipher'

export type TaskRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type TaskGuardState = 'watching' | 'nudged' | 'escalated'

export interface TaskRun {
  id: string
  taskId: string
  sessionId: string
  attempt: number
  status: TaskRunStatus
  heartbeatAt: string
  lastProgressAt: string
  leaseOwner: string
  leaseExpiresAt: string
  guardState: TaskGuardState
  guardAttempts: number
  guardUpdatedAt?: string
  lastError?: string
  startedAt: string
  endedAt?: string
  createdAt: string
  updatedAt: string
}

interface TaskRunRow {
  id: string
  task_id: string
  session_id: string
  attempt: number
  status: string
  heartbeat_at: string
  last_progress_at: string
  lease_owner: string
  lease_expires_at: string
  guard_state: string
  guard_attempts: number
  guard_updated_at: string | null
  last_error_ciphertext: Uint8Array | null
  last_error_nonce: Uint8Array | null
  last_error_tag: Uint8Array | null
  started_at: string
  ended_at: string | null
  created_at: string
  updated_at: string
}

const STATUSES: readonly TaskRunStatus[] = ['running', 'waiting', 'completed', 'failed', 'cancelled']
const GUARD_STATES: readonly TaskGuardState[] = ['watching', 'nudged', 'escalated']

/** Durable execution attempts for a Task. A Task can have many runs; the UI still sees one Task. */
export class TaskRunStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        last_progress_at TEXT NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        guard_state TEXT NOT NULL DEFAULT 'watching',
        guard_attempts INTEGER NOT NULL DEFAULT 0,
        guard_updated_at TEXT,
        last_error_ciphertext BLOB,
        last_error_nonce BLOB,
        last_error_tag BLOB,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, attempt)
      );

      CREATE INDEX IF NOT EXISTS task_runs_running
        ON task_runs(status, heartbeat_at ASC);
      CREATE INDEX IF NOT EXISTS task_runs_task
        ON task_runs(task_id, attempt DESC);
      CREATE INDEX IF NOT EXISTS task_runs_session
        ON task_runs(session_id, updated_at DESC);
    `)
  }

  start(input: {
    taskId: string
    sessionId: string
    leaseOwner: string
    leaseMs: number
    now?: Date
  }, runId: string = randomUUID()): TaskRun {
    const now = input.now ?? new Date()
    const at = now.toISOString()
    const attempt = (this.database.prepare(`
      SELECT COALESCE(MAX(attempt), 0) AS attempt FROM task_runs WHERE task_id = ?
    `).get(input.taskId) as { attempt: number }).attempt + 1
    this.database.prepare(`
      INSERT INTO task_runs (
        id, task_id, session_id, attempt, status,
        heartbeat_at, last_progress_at, lease_owner, lease_expires_at,
        guard_state, guard_attempts, guard_updated_at,
        last_error_ciphertext, last_error_nonce, last_error_tag,
        started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 'watching', 0, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)
    `).run(
      runId,
      input.taskId,
      input.sessionId,
      attempt,
      at,
      at,
      input.leaseOwner,
      new Date(now.getTime() + input.leaseMs).toISOString(),
      at,
      at,
      at,
    )
    return this.get(runId)
  }

  get(runId: string): TaskRun {
    const row = this.database.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as TaskRunRow | undefined
    if (row === undefined) throw new Error(`Unknown Task run: ${runId}`)
    return this.toRun(row)
  }

  latest(taskId: string): TaskRun | undefined {
    const row = this.database.prepare(`
      SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1
    `).get(taskId) as TaskRunRow | undefined
    return row === undefined ? undefined : this.toRun(row)
  }

  bySession(sessionId: string): TaskRun | undefined {
    const row = this.database.prepare(`
      SELECT * FROM task_runs WHERE session_id = ? ORDER BY attempt DESC LIMIT 1
    `).get(sessionId) as TaskRunRow | undefined
    return row === undefined ? undefined : this.toRun(row)
  }

  listRunning(): TaskRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM task_runs WHERE status = 'running' ORDER BY heartbeat_at ASC, created_at ASC
    `).all() as unknown as TaskRunRow[]
    return rows.map((row) => this.toRun(row))
  }

  heartbeat(runId: string, leaseMs: number, progress = true, now = new Date()): TaskRun {
    const at = now.toISOString()
    this.database.prepare(`
      UPDATE task_runs SET
        heartbeat_at = ?,
        last_progress_at = CASE WHEN ? = 1 THEN ? ELSE last_progress_at END,
        lease_expires_at = ?,
        updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(at, progress ? 1 : 0, at, new Date(now.getTime() + leaseMs).toISOString(), at, runId)
    return this.get(runId)
  }

  heartbeatSession(sessionId: string, leaseMs: number, progress = true, now = new Date()): TaskRun | undefined {
    const row = this.database.prepare(`
      SELECT id FROM task_runs
      WHERE session_id = ? AND status = 'running'
      ORDER BY attempt DESC LIMIT 1
    `).get(sessionId) as { id: string } | undefined
    return row === undefined ? undefined : this.heartbeat(row.id, leaseMs, progress, now)
  }

  setStatus(runId: string, status: TaskRunStatus, error?: string, now = new Date()): TaskRun {
    if (!STATUSES.includes(status)) throw new Error(`Unknown Task run status: ${status}`)
    const at = now.toISOString()
    const encrypted = error === undefined ? undefined : this.cipher.encrypt(error.slice(0, 2_000), errorAssociatedData(runId))
    this.database.prepare(`
      UPDATE task_runs SET
        status = ?, ended_at = CASE WHEN ? = 'running' THEN NULL ELSE ? END,
        last_error_ciphertext = ?, last_error_nonce = ?, last_error_tag = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      status,
      at,
      encrypted?.ciphertext ?? null,
      encrypted?.nonce ?? null,
      encrypted?.tag ?? null,
      at,
      runId,
    )
    return this.get(runId)
  }

  finishLatest(taskId: string, status: TaskRunStatus, error?: string, now = new Date()): TaskRun | undefined {
    const run = this.latest(taskId)
    if (run === undefined || run.status !== 'running') return run
    return this.setStatus(run.id, status, error, now)
  }

  guard(runId: string, state: TaskGuardState, now = new Date()): TaskRun {
    if (!GUARD_STATES.includes(state)) throw new Error(`Unknown Task guard state: ${state}`)
    const at = now.toISOString()
    this.database.prepare(`
      UPDATE task_runs SET
        guard_state = ?,
        guard_attempts = guard_attempts + CASE WHEN ? IN ('nudged', 'escalated') THEN 1 ELSE 0 END,
        guard_updated_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(state, state, at, at, runId)
    return this.get(runId)
  }

  recovery(runId: string, now = new Date()): TaskRun {
    return this.setStatus(runId, 'failed', 'Host restarted before the run settled.', now)
  }

  recoverInterruptedRuns(now = new Date()): number {
    const rows = this.listRunning()
    for (const run of rows) this.recovery(run.id, now)
    return rows.length
  }

  private toRun(row: TaskRunRow): TaskRun {
    const run: TaskRun = {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      attempt: row.attempt,
      status: requireStatus(row.status),
      heartbeatAt: row.heartbeat_at,
      lastProgressAt: row.last_progress_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      guardState: requireGuardState(row.guard_state),
      guardAttempts: row.guard_attempts,
      startedAt: row.started_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.guard_updated_at !== null) run.guardUpdatedAt = row.guard_updated_at
    if (row.ended_at !== null) run.endedAt = row.ended_at
    const fields = [row.last_error_ciphertext, row.last_error_nonce, row.last_error_tag]
    if (fields.some((field) => field !== null)) {
      if (fields.some((field) => field === null)) throw new Error(`Incomplete encrypted Task run error: ${row.id}`)
      run.lastError = this.cipher.decrypt({
        ciphertext: row.last_error_ciphertext!,
        nonce: row.last_error_nonce!,
        tag: row.last_error_tag!,
      }, errorAssociatedData(row.id)) as string
    }
    return run
  }
}

function requireStatus(value: string): TaskRunStatus {
  if (STATUSES.includes(value as TaskRunStatus)) return value as TaskRunStatus
  throw new Error(`Unknown Task run status: ${value}`)
}

function requireGuardState(value: string): TaskGuardState {
  if (GUARD_STATES.includes(value as TaskGuardState)) return value as TaskGuardState
  throw new Error(`Unknown Task guard state: ${value}`)
}

function errorAssociatedData(runId: string): string {
  return `task-run:${runId}:error`
}
