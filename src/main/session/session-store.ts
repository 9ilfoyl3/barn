import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionSummary } from '../../shared/models'
import { AesGcmEventCipher } from './event-cipher'
import { TaskStore } from '../tasks/task-store'
import { PermissionStore } from '../permissions/permission-store'
import { ActionStore } from '../actions/action-store'
import { LocalSourceStore } from '../sources/local-source-store'
import { MemoryStore } from '../memory/memory-store'
import { ThreadStore } from '../threads/thread-store'

export type SessionStatus = SessionSummary['status']

// Schema 7 adds the Principal Thread and visible-message history. Older schema
// versions are upgraded in place by idempotent store initialization.
export const CURRENT_SCHEMA_VERSION = 7

export interface NewSessionEvent {
  type: string
  data: unknown
  actor?: { kind: 'user' | 'agent' | 'system'; id: string }
}

export interface StoredSessionEvent extends Omit<NewSessionEvent, 'actor'> {
  sessionId: string
  seq: number
  eventId: string
  actor: { kind: 'user' | 'agent' | 'system'; id: string }
  createdAt: string
}

export class SessionStore {
  private readonly database: DatabaseSync
  readonly tasks: TaskStore
  readonly permissions: PermissionStore
  readonly actions: ActionStore
  readonly localSources: LocalSourceStore
  readonly memories: MemoryStore
  readonly threads: ThreadStore

  constructor(
    path: string,
    private readonly cipher: AesGcmEventCipher,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(path)
    this.tasks = new TaskStore(this.database, cipher)
    this.permissions = new PermissionStore(this.database, cipher)
    this.actions = new ActionStore(this.database, cipher)
    this.localSources = new LocalSourceStore(this.database, cipher)
    this.memories = new MemoryStore(this.database, cipher)
    this.threads = new ThreadStore(this.database, cipher)
  }

  async initialize(): Promise<void> {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS maintenance_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        retention_days INTEGER NOT NULL,
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        has_unread_result INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        working_directory TEXT,
        parent_session_id TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        actor_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `)
    this.ensureSessionColumns()
    const current = this.database.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as { version: number } | undefined
    if (current !== undefined && current.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Database schema ${current.version} is newer than this app supports (${CURRENT_SCHEMA_VERSION})`)
    }
    this.tasks.initialize()
    this.permissions.initialize()
    this.actions.initialize()
    this.localSources.initialize()
    this.memories.initialize()
    this.threads.initialize()
    this.database.prepare(`
      INSERT INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
    `).run(CURRENT_SCHEMA_VERSION, new Date().toISOString())
    this.database.prepare(`
      INSERT OR IGNORE INTO maintenance_settings (id, retention_days, last_run_at)
      VALUES (1, 365, NULL)
    `).run()
    this.pruneEmptySessions()
  }

  schemaVersion(): number {
    const row = this.database.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as { version: number } | undefined
    return row?.version ?? 0
  }

  getRetentionDays(): number {
    const row = this.database.prepare('SELECT retention_days FROM maintenance_settings WHERE id = 1')
      .get() as { retention_days: number } | undefined
    return row?.retention_days ?? 365
  }

  setRetentionDays(days: number): number {
    if (!Number.isInteger(days) || days < 30 || days > 3_650) {
      throw new Error('Retention must be between 30 and 3,650 days')
    }
    this.database.prepare('UPDATE maintenance_settings SET retention_days = ? WHERE id = 1').run(days)
    return days
  }

  lastMaintenanceAt(): string | undefined {
    const row = this.database.prepare('SELECT last_run_at FROM maintenance_settings WHERE id = 1')
      .get() as { last_run_at: string | null } | undefined
    return row?.last_run_at ?? undefined
  }

  runRetention(now = new Date()): { cutoff: string; actionEvents: number; sourceEvents: number; approvals: number } {
    const cutoff = new Date(now.getTime() - this.getRetentionDays() * 24 * 60 * 60 * 1_000).toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const actionEvents = Number(this.database.prepare(`
        DELETE FROM action_events
        WHERE action_id IN (
          SELECT id FROM actions
          WHERE status IN ('succeeded', 'failed', 'cancelled')
            AND completed_at IS NOT NULL AND completed_at < ?
        )
      `).run(cutoff).changes)
      const sourceEvents = Number(this.database.prepare(`
        DELETE FROM local_source_events WHERE created_at < ? AND task_id IS NULL
      `).run(cutoff).changes)
      const approvals = Number(this.database.prepare(`
        DELETE FROM approvals
        WHERE status IN ('approved', 'denied')
          AND resolved_at IS NOT NULL AND resolved_at < ?
          AND id NOT IN (SELECT approval_id FROM actions WHERE approval_id IS NOT NULL)
      `).run(cutoff).changes)
      this.database.prepare('UPDATE maintenance_settings SET last_run_at = ? WHERE id = 1')
        .run(now.toISOString())
      this.database.exec('COMMIT')
      return { cutoff, actionEvents, sourceEvents, approvals }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  diagnosticsCounts(): {
    sessions: number
    tasks: number
    approvalsPending: number
    actionsActive: number
    localSources: number
  } {
    const count = (sql: string): number => Number((this.database.prepare(sql).get() as { count: number }).count)
    return {
      sessions: count('SELECT COUNT(*) AS count FROM sessions'),
      tasks: count('SELECT COUNT(*) AS count FROM tasks'),
      approvalsPending: count(`SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'`),
      actionsActive: count(`SELECT COUNT(*) AS count FROM actions WHERE status IN ('pending_approval', 'queued', 'running')`),
      localSources: count('SELECT COUNT(*) AS count FROM local_sources'),
    }
  }

  createSession(
    title = 'New session',
    sessionId: string = randomUUID(),
    workingDirectory?: string,
    parentSessionId?: string,
  ): SessionSummary {
    const now = new Date().toISOString()
    const session: SessionSummary = {
      id: sessionId,
      title,
      status: 'idle',
      hasUnreadResult: false,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    }
    if (workingDirectory !== undefined) session.workingDirectory = workingDirectory
    if (parentSessionId !== undefined) session.parentSessionId = parentSessionId
    this.database.prepare(`
      INSERT INTO sessions (
        id, title, status, has_unread_result, pinned, archived_at,
        working_directory, parent_session_id, last_seq, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 0, NULL, ?, ?, 0, ?, ?)
    `).run(
      session.id,
      session.title,
      session.status,
      session.workingDirectory ?? null,
      session.parentSessionId ?? null,
      now,
      now,
    )
    return session
  }

  ensureSession(
    sessionId: string,
    title = 'New session',
    workingDirectory?: string,
    parentSessionId?: string,
  ): SessionSummary {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT OR IGNORE INTO sessions (
        id, title, status, has_unread_result, pinned, archived_at,
        working_directory, parent_session_id, last_seq, created_at, updated_at
      ) VALUES (?, ?, 'idle', 0, 0, NULL, ?, ?, 0, ?, ?)
    `).run(sessionId, title, workingDirectory ?? null, parentSessionId ?? null, now, now)
    return this.getSession(sessionId)
  }

  getSession(sessionId: string): SessionSummary {
    const row = this.database.prepare(`
      SELECT id, title, status, has_unread_result, pinned, archived_at,
             working_directory, parent_session_id, created_at, updated_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as SessionRow | undefined
    if (row === undefined) throw new Error(`Unknown session: ${sessionId}`)
    return toSessionSummary(row)
  }

  updateStatus(sessionId: string, status: SessionStatus): SessionSummary {
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, updatedAt, sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  markResultUnread(sessionId: string): SessionSummary {
    const result = this.database.prepare(`
      UPDATE sessions SET has_unread_result = 1 WHERE id = ?
    `).run(sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  markResultRead(sessionId: string): SessionSummary {
    const result = this.database.prepare(`
      UPDATE sessions SET has_unread_result = 0 WHERE id = ?
    `).run(sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  setPinned(sessionId: string, pinned: boolean): SessionSummary {
    const result = this.database.prepare(`
      UPDATE sessions SET pinned = ? WHERE id = ?
    `).run(pinned ? 1 : 0, sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  setArchived(sessionId: string, archived: boolean): SessionSummary {
    const result = this.database.prepare(`
      UPDATE sessions
      SET archived_at = ?, has_unread_result = CASE WHEN ? = 1 THEN 0 ELSE has_unread_result END
      WHERE id = ?
    `).run(archived ? new Date().toISOString() : null, archived ? 1 : 0, sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  updateWorkingDirectory(sessionId: string, workingDirectory: string): SessionSummary {
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE sessions SET working_directory = ?, updated_at = ? WHERE id = ?
    `).run(workingDirectory, updatedAt, sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  clearWorkingDirectory(sessionId: string): SessionSummary {
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE sessions SET working_directory = NULL, updated_at = ? WHERE id = ?
    `).run(updatedAt, sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  updateTitle(sessionId: string, title: string): SessionSummary {
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?
    `).run(title, updatedAt, sessionId)
    if (result.changes === 0) throw new Error(`Unknown session: ${sessionId}`)
    return this.getSession(sessionId)
  }

  recoverInterruptedSessions(): number {
    const result = this.database.prepare(`
      UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'
    `).run(new Date().toISOString())
    return Number(result.changes)
  }

  listSessions(): SessionSummary[] {
    const rows = this.database.prepare(`
      SELECT id, title, status, has_unread_result, pinned, archived_at,
             working_directory, parent_session_id, created_at, updated_at
      FROM sessions
      WHERE last_seq > 0
        AND parent_session_id IS NULL
      ORDER BY
        CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
        pinned DESC,
        updated_at DESC
    `).all() as Array<{
      id: string
      title: string
      status: string
      has_unread_result: number
      pinned: number
      archived_at: string | null
      working_directory: string | null
      parent_session_id: string | null
      created_at: string
      updated_at: string
    }>

    return rows.map(toSessionSummary)
  }

  append(sessionId: string, events: NewSessionEvent[]): StoredSessionEvent[] {
    if (events.length === 0) return []
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const session = this.database.prepare(`
        SELECT last_seq FROM sessions WHERE id = ?
      `).get(sessionId) as { last_seq: number } | undefined
      if (session === undefined) throw new Error(`Unknown session: ${sessionId}`)

      const stored: StoredSessionEvent[] = []
      let nextSeq = session.last_seq + 1
      for (const event of events) {
        const createdAt = new Date().toISOString()
        const actor = event.actor ?? { kind: 'agent' as const, id: 'barn' }
        const eventId = randomUUID()
        const encrypted = this.cipher.encrypt(
          event.data,
          associatedData(sessionId, nextSeq, event.type),
        )
        this.database.prepare(`
          INSERT INTO session_events (
            session_id, seq, event_id, type,
            payload_ciphertext, payload_nonce, payload_tag,
            actor_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          nextSeq,
          eventId,
          event.type,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          JSON.stringify(actor),
          createdAt,
        )
        stored.push({
          ...event,
          actor,
          sessionId,
          seq: nextSeq,
          eventId,
          createdAt,
        })
        nextSeq++
      }

      const updatedAt = new Date().toISOString()
      this.database.prepare(`
        UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?
      `).run(nextSeq - 1, updatedAt, sessionId)
      this.database.exec('COMMIT')
      return stored
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  read(sessionId: string): StoredSessionEvent[] {
    const rows = this.database.prepare(`
      SELECT session_id, seq, event_id, type,
             payload_ciphertext, payload_nonce, payload_tag,
             actor_json, created_at
      FROM session_events
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(sessionId) as Array<{
      session_id: string
      seq: number
      event_id: string
      type: string
      payload_ciphertext: Uint8Array
      payload_nonce: Uint8Array
      payload_tag: Uint8Array
      actor_json: string
      created_at: string
    }>

    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      eventId: row.event_id,
      type: row.type,
      data: this.cipher.decrypt(
        {
          ciphertext: row.payload_ciphertext,
          nonce: row.payload_nonce,
          tag: row.payload_tag,
        },
        associatedData(row.session_id, row.seq, row.type),
      ),
      actor: JSON.parse(row.actor_json) as StoredSessionEvent['actor'],
      createdAt: row.created_at,
    }))
  }

  close(): void {
    this.database.close()
  }

  private ensureSessionColumns(): void {
    const columns = new Set((this.database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name))
    if (!columns.has('working_directory')) this.database.exec('ALTER TABLE sessions ADD COLUMN working_directory TEXT')
    if (!columns.has('has_unread_result')) this.database.exec('ALTER TABLE sessions ADD COLUMN has_unread_result INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('pinned')) this.database.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('archived_at')) this.database.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT')
    if (!columns.has('parent_session_id')) this.database.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT')
  }

  private pruneEmptySessions(): void {
    this.database.prepare(`
      DELETE FROM sessions
      WHERE last_seq = 0
        AND id <> (
          SELECT id
          FROM sessions
          WHERE last_seq = 0
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT 1
        )
    `).run()
  }
}

interface SessionRow {
  id: string
  title: string
  status: string
  has_unread_result: number
  pinned: number
  archived_at: string | null
  working_directory: string | null
  parent_session_id: string | null
  created_at: string
  updated_at: string
}

function toSessionSummary(row: SessionRow): SessionSummary {
  const session: SessionSummary = {
    id: row.id,
    title: row.title,
    status: normalizeStatus(row.status),
    hasUnreadResult: row.has_unread_result === 1,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.archived_at !== null) session.archivedAt = row.archived_at
  if (row.working_directory !== null) session.workingDirectory = row.working_directory
  if (row.parent_session_id !== null) session.parentSessionId = row.parent_session_id
  return session
}

function associatedData(sessionId: string, seq: number, type: string): string {
  return `${sessionId}:${seq}:${type}`
}

function normalizeStatus(status: string): SessionStatus {
  return status === 'running' || status === 'failed' ? status : 'idle'
}
