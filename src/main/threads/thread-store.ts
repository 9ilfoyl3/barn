import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AppendVisibleMessageInput,
  PrincipalThread,
  VisibleMessage,
  VisibleMessageRole,
} from '../../shared/models'
import type { AesGcmEventCipher } from '../session/event-cipher'

export const PRIMARY_THREAD_ID = 'primary'

const DEFAULT_MESSAGE_LIMIT = 500
const MAX_MESSAGE_LIMIT = 1_000
const ROLES: readonly VisibleMessageRole[] = ['user', 'assistant', 'system']

interface ThreadRow {
  id: string
  created_at: string
  updated_at: string
  last_visible_seq: number
}

interface MessageRow {
  id: string
  thread_id: string
  seq: number
  client_message_id: string | null
  role: string
  payload_ciphertext: Uint8Array
  payload_nonce: Uint8Array
  payload_tag: Uint8Array
  created_at: string
}

interface MessagePayload {
  content: unknown
  metadata: Record<string, unknown>
  sourceRefs: string[]
}

export interface ListVisibleMessagesOptions {
  afterSeq?: number
  limit?: number
}

/** Canonical user-visible history, independent from model execution Sessions. */
export class ThreadStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS principal_threads (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_visible_seq INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS visible_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES principal_threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        client_message_id TEXT,
        role TEXT NOT NULL,
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, seq),
        UNIQUE(thread_id, client_message_id)
      );

      CREATE INDEX IF NOT EXISTS visible_messages_thread_seq
        ON visible_messages(thread_id, seq ASC);
    `)
    this.ensurePrimaryThread()
  }

  getPrimaryThread(): PrincipalThread {
    return this.getThread(PRIMARY_THREAD_ID)
  }

  getThread(threadId: string): PrincipalThread {
    const row = this.database.prepare(`
      SELECT id, created_at, updated_at, last_visible_seq
      FROM principal_threads WHERE id = ?
    `).get(threadId) as ThreadRow | undefined
    if (row === undefined) throw new Error(`Unknown principal thread: ${threadId}`)
    return toPrincipalThread(row)
  }

  appendPrimaryMessage(input: AppendVisibleMessageInput): VisibleMessage {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const message = this.appendPrimaryMessageInTransaction(input)
      this.database.exec('COMMIT')
      return message
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Append inside an existing write transaction owned by a higher-level service. */
  appendPrimaryMessageInTransaction(input: AppendVisibleMessageInput): VisibleMessage {
    const role = requireRole(input.role)
    const clientMessageId = normalizeClientMessageId(input.clientMessageId)
    const thread = this.database.prepare(`
      SELECT id, created_at, updated_at, last_visible_seq
      FROM principal_threads WHERE id = ?
    `).get(PRIMARY_THREAD_ID) as ThreadRow | undefined
    if (thread === undefined) throw new Error('Primary thread is not initialized')

    if (clientMessageId !== undefined) {
      const existing = this.database.prepare(`
        SELECT id FROM visible_messages
        WHERE thread_id = ? AND client_message_id = ?
      `).get(PRIMARY_THREAD_ID, clientMessageId) as { id: string } | undefined
      if (existing !== undefined) return this.getPrimaryMessage(existing.id)
    }

    const seq = thread.last_visible_seq + 1
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const payload: MessagePayload = {
      content: input.content,
      metadata: input.metadata ?? {},
      sourceRefs: normalizeSourceRefs(input.sourceRefs),
    }
    const encrypted = this.cipher.encrypt(payload, messageAssociatedData(PRIMARY_THREAD_ID, seq))
    this.database.prepare(`
      INSERT INTO visible_messages (
        id, thread_id, seq, client_message_id, role,
        payload_ciphertext, payload_nonce, payload_tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      PRIMARY_THREAD_ID,
      seq,
      clientMessageId ?? null,
      role,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      createdAt,
    )
    this.database.prepare(`
      UPDATE principal_threads
      SET last_visible_seq = ?, updated_at = ?
      WHERE id = ?
    `).run(seq, createdAt, PRIMARY_THREAD_ID)
    return this.getPrimaryMessage(id)
  }

  listPrimaryMessages(options: ListVisibleMessagesOptions = {}): VisibleMessage[] {
    const afterSeq = normalizeNonNegativeInteger(options.afterSeq ?? 0, 'afterSeq')
    const limit = normalizeLimit(options.limit ?? DEFAULT_MESSAGE_LIMIT)
    const rows = this.database.prepare(`
      SELECT id, thread_id, seq, client_message_id, role,
             payload_ciphertext, payload_nonce, payload_tag, created_at
      FROM visible_messages
      WHERE thread_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(PRIMARY_THREAD_ID, afterSeq, limit) as unknown as MessageRow[]
    return rows.map((row) => this.toVisibleMessage(row))
  }

  private ensurePrimaryThread(): PrincipalThread {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT OR IGNORE INTO principal_threads (id, created_at, updated_at, last_visible_seq)
      VALUES (?, ?, ?, 0)
    `).run(PRIMARY_THREAD_ID, now, now)
    return this.getPrimaryThread()
  }

  getPrimaryMessage(id: string): VisibleMessage {
    const row = this.database.prepare(`
      SELECT id, thread_id, seq, client_message_id, role,
             payload_ciphertext, payload_nonce, payload_tag, created_at
      FROM visible_messages WHERE id = ?
    `).get(id) as MessageRow | undefined
    if (row === undefined) throw new Error(`Unknown visible message: ${id}`)
    return this.toVisibleMessage(row)
  }

  private toVisibleMessage(row: MessageRow): VisibleMessage {
    const payload = this.cipher.decrypt<MessagePayload>({
      ciphertext: row.payload_ciphertext,
      nonce: row.payload_nonce,
      tag: row.payload_tag,
    }, messageAssociatedData(row.thread_id, row.seq))
    const message: VisibleMessage = {
      id: row.id,
      threadId: row.thread_id,
      seq: row.seq,
      role: requireRole(row.role),
      content: payload.content,
      metadata: payload.metadata,
      sourceRefs: payload.sourceRefs,
      createdAt: row.created_at,
    }
    if (row.client_message_id !== null) message.clientMessageId = row.client_message_id
    return message
  }
}

function toPrincipalThread(row: ThreadRow): PrincipalThread {
  return {
    id: row.id,
    lastVisibleSeq: row.last_visible_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireRole(value: string): VisibleMessageRole {
  if (!ROLES.includes(value as VisibleMessageRole)) throw new Error(`Unknown visible message role: ${value}`)
  return value as VisibleMessageRole
}

function normalizeClientMessageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 500) {
    throw new Error('clientMessageId must be between 1 and 500 characters')
  }
  return normalized
}

function normalizeSourceRefs(refs: string[] | undefined): string[] {
  if (refs === undefined) return []
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))]
}

function normalizeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('limit must be a positive integer')
  return Math.min(value, MAX_MESSAGE_LIMIT)
}

function messageAssociatedData(threadId: string, seq: number): string {
  return `thread:${threadId}:${seq}:visible-message`
}
