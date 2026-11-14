import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionSummary } from '../../shared/models'
import { AesGcmEventCipher } from './event-cipher'
import { TaskStore } from '../tasks/task-store'
import { PermissionStore } from '../permissions/permission-store'

export type SessionStatus = SessionSummary['status']

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

  constructor(
    path: string,
    private readonly cipher: AesGcmEventCipher,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(path)
    this.tasks = new TaskStore(this.database, cipher)
    this.permissions = new PermissionStore(this.database, cipher)
  }

  async initialize(): Promise<void> {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
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
    this.tasks.initialize()
    this.permissions.initialize()
    this.pruneEmptySessions()
  }

  createSession(title = 'New session', sessionId: string = randomUUID()): SessionSummary {
    const now = new Date().toISOString()
    const session: SessionSummary = {
      id: sessionId,
      title,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    }
    this.database.prepare(`
      INSERT INTO sessions (id, title, status, last_seq, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(session.id, session.title, session.status, now, now)
    return session
  }

  ensureSession(sessionId: string, title = 'New session'): SessionSummary {
    const row = this.database.prepare(`
      SELECT id, title, status, created_at, updated_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as SessionRow | undefined
    return row === undefined ? this.createSession(title, sessionId) : toSessionSummary(row)
  }

  getSession(sessionId: string): SessionSummary {
    const row = this.database.prepare(`
      SELECT id, title, status, created_at, updated_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as {
      id: string
      title: string
      status: string
      created_at: string
      updated_at: string
    } | undefined
    if (row === undefined) throw new Error(`Unknown session: ${sessionId}`)
    return {
      id: row.id,
      title: row.title,
      status: normalizeStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  updateStatus(sessionId: string, status: SessionStatus): SessionSummary {
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, updatedAt, sessionId)
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
      SELECT id, title, status, created_at, updated_at
      FROM sessions
      WHERE last_seq > 0
      ORDER BY updated_at DESC
    `).all() as Array<{
      id: string
      title: string
      status: string
      created_at: string
      updated_at: string
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: normalizeStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
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
  created_at: string
  updated_at: string
}

function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    status: normalizeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function associatedData(sessionId: string, seq: number, type: string): string {
  return `${sessionId}:${seq}:${type}`
}

function normalizeStatus(status: string): SessionStatus {
  return status === 'running' || status === 'failed' ? status : 'idle'
}
