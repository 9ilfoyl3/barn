import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RoutineNotification, Task, TaskResultEnvelope } from '../../shared/models'
import type { AesGcmEventCipher } from '../session/event-cipher'

interface RoutineRow {
  id: string
  task_id: string
  source_label: string
  provider: string
  title: string
  body_ciphertext: Uint8Array
  body_nonce: Uint8Array
  body_tag: Uint8Array
  url: string | null
  outcome: string
  created_at: string
  acknowledged_at: string | null
}

export type RoutineNotificationEvent = { type: 'routine.created' | 'routine.dismissed'; notification: RoutineNotification }

/** Durable routine projection of completed background work; never a Router message. */
export class RoutineStore {
  private readonly listeners = new Set<(event: RoutineNotificationEvent) => void>()

  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS routine_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        source_label TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        body_ciphertext BLOB NOT NULL,
        body_nonce BLOB NOT NULL,
        body_tag BLOB NOT NULL,
        url TEXT,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );

      CREATE INDEX IF NOT EXISTS routine_notifications_open
        ON routine_notifications(acknowledged_at, created_at DESC);
    `)
  }

  record(task: Task, result: TaskResultEnvelope, now = new Date()): RoutineNotification {
    const existing = this.database.prepare('SELECT * FROM routine_notifications WHERE task_id = ?').get(task.id) as RoutineRow | undefined
    const source = routineSource(task)
    const notificationId = existing?.id ?? randomUUID()
    const title = plainTextPreview(task.title, 240)
    const body = plainTextPreview(result.summary.trim() || task.title, 20_000)
    const encrypted = this.cipher.encrypt(body, associatedData(notificationId))
    const at = now.toISOString()
    this.database.prepare(`
      INSERT INTO routine_notifications (
        id, task_id, source_label, provider, title,
        body_ciphertext, body_nonce, body_tag, url, outcome,
        created_at, acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(task_id) DO UPDATE SET
        source_label = excluded.source_label,
        provider = excluded.provider,
        title = excluded.title,
        body_ciphertext = excluded.body_ciphertext,
        body_nonce = excluded.body_nonce,
        body_tag = excluded.body_tag,
        url = excluded.url,
        outcome = excluded.outcome,
        created_at = excluded.created_at,
        acknowledged_at = NULL
    `).run(
      notificationId,
      task.id,
      source.label,
      source.provider,
      title,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      source.url ?? null,
      result.outcome,
      at,
    )
    const notification = this.get(notificationId)
    this.emit({ type: 'routine.created', notification })
    return notification
  }

  list(limit = 50): RoutineNotification[] {
    const rows = this.database.prepare(`
      SELECT * FROM routine_notifications
      WHERE acknowledged_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, Math.trunc(limit)))) as unknown as RoutineRow[]
    return rows.map((row) => this.toNotification(row))
  }

  get(id: string): RoutineNotification {
    const row = this.database.prepare('SELECT * FROM routine_notifications WHERE id = ?').get(id) as RoutineRow | undefined
    if (row === undefined) throw new Error(`Unknown routine notification: ${id}`)
    return this.toNotification(row)
  }

  acknowledge(id: string, now = new Date()): RoutineNotification {
    this.database.prepare(`
      UPDATE routine_notifications SET acknowledged_at = ? WHERE id = ?
    `).run(now.toISOString(), id)
    const notification = this.get(id)
    this.emit({ type: 'routine.dismissed', notification })
    return notification
  }

  onEvent(listener: (event: RoutineNotificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activeCount(): number {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM routine_notifications WHERE acknowledged_at IS NULL
    `).get() as { count: number }).count)
  }

  private emit(event: RoutineNotificationEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private toNotification(row: RoutineRow): RoutineNotification {
    const notification: RoutineNotification = {
      id: row.id,
      taskId: row.task_id,
      sourceLabel: row.source_label,
      provider: row.provider,
      title: row.title,
      body: this.cipher.decrypt({
        ciphertext: row.body_ciphertext,
        nonce: row.body_nonce,
        tag: row.body_tag,
      }, associatedData(row.id)),
      outcome: row.outcome as RoutineNotification['outcome'],
      createdAt: row.created_at,
    }
    if (row.url !== null) notification.url = row.url
    if (row.acknowledged_at !== null) notification.acknowledgedAt = row.acknowledged_at
    return notification
  }
}

function routineSource(task: Task): { label: string; provider: string; url?: string } {
  const title = task.title.toLocaleLowerCase()
  const refs = task.contract?.sourceRefs ?? []
  const url = refs.find((ref) => /^https?:\/\//u.test(ref))
  if (title.includes('dingtalk')) return { label: 'DingTalk', provider: 'dingtalk', ...(url === undefined ? {} : { url }) }
  if (title.includes('github')) return { label: 'GitHub', provider: 'github', ...(url === undefined ? {} : { url }) }
  return { label: 'Barn', provider: 'barn', ...(url === undefined ? {} : { url }) }
}

function plainTextPreview(value: string, max: number): string {
  const plain = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/(^|\s)#{1,6}\s+/gu, '$1')
    .replace(/^\s{0,3}>\s?/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/\|/gu, ' ')
    .replace(/^\s*[-:| ]+\s*$/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`
}

function associatedData(id: string): string {
  return `routine:${id}:body`
}
