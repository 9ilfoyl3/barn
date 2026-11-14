import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AesGcmEventCipher } from '../session/event-cipher'
import type { ActionEvent, ActionRecord, ActionRequestInput, ActionStatus } from './types'

const STATUSES: readonly ActionStatus[] = ['pending_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled']

interface ActionRow {
  id: string
  kind: string
  idempotency_key: string
  title: string
  summary_ciphertext: Uint8Array
  summary_nonce: Uint8Array
  summary_tag: Uint8Array
  details_ciphertext: Uint8Array | null
  details_nonce: Uint8Array | null
  details_tag: Uint8Array | null
  status: string
  task_id: string | null
  approval_id: string | null
  payload_ciphertext: Uint8Array
  payload_nonce: Uint8Array
  payload_tag: Uint8Array
  attempts: number
  max_attempts: number
  next_attempt_at: string | null
  last_error_ciphertext: Uint8Array | null
  last_error_nonce: Uint8Array | null
  last_error_tag: Uint8Array | null
  result_ciphertext: Uint8Array | null
  result_nonce: Uint8Array | null
  result_tag: Uint8Array | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ActionEventRow {
  id: number
  action_id: string
  type: string
  data_ciphertext: Uint8Array
  data_nonce: Uint8Array
  data_tag: Uint8Array
  created_at: string
}

export class ActionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary_ciphertext BLOB NOT NULL,
        summary_nonce BLOB NOT NULL,
        summary_tag BLOB NOT NULL,
        details_ciphertext BLOB,
        details_nonce BLOB,
        details_tag BLOB,
        status TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT,
        last_error_ciphertext BLOB,
        last_error_nonce BLOB,
        last_error_tag BLOB,
        result_ciphertext BLOB,
        result_nonce BLOB,
        result_tag BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS actions_due
        ON actions(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS actions_approval
        ON actions(approval_id);

      CREATE TABLE IF NOT EXISTS action_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data_ciphertext BLOB NOT NULL,
        data_nonce BLOB NOT NULL,
        data_tag BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS action_events_action
        ON action_events(action_id, id);
    `)
  }

  create(
    input: ActionRequestInput,
    status: ActionStatus,
    approvalId?: string,
    actionId: string = randomUUID(),
  ): ActionRecord {
    const kind = requireText(input.kind, 'Action kind', 120)
    const idempotencyKey = requireText(input.idempotencyKey, 'Idempotency key', 500)
    const title = requireText(input.title, 'Action title', 200)
    const summaryText = requireText(input.summary, 'Action summary', 2_000)
    const detailsText = input.details === undefined ? undefined : requireText(input.details, 'Action details', 20_000)
    const maxAttempts = input.maxAttempts ?? 5
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error('Action max attempts must be an integer between 1 and 20')
    }
    const existing = this.findByIdempotencyKey(idempotencyKey)
    if (existing !== undefined) return existing
    const now = new Date().toISOString()
    const payload = this.cipher.encrypt(input.payload, actionAssociatedData(actionId, 'payload'))
    const summary = this.cipher.encrypt(summaryText, actionAssociatedData(actionId, 'summary'))
    const details = detailsText === undefined
      ? undefined
      : this.cipher.encrypt(detailsText, actionAssociatedData(actionId, 'details'))
    this.database.prepare(`
      INSERT INTO actions (
        id, kind, idempotency_key, title,
        summary_ciphertext, summary_nonce, summary_tag,
        details_ciphertext, details_nonce, details_tag,
        status, task_id, approval_id,
        payload_ciphertext, payload_nonce, payload_tag,
        attempts, max_attempts, next_attempt_at,
        last_error_ciphertext, last_error_nonce, last_error_tag,
        result_ciphertext, result_nonce, result_tag,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
    `).run(
      actionId,
      kind,
      idempotencyKey,
      title,
      summary.ciphertext,
      summary.nonce,
      summary.tag,
      details?.ciphertext ?? null,
      details?.nonce ?? null,
      details?.tag ?? null,
      status,
      input.taskId ?? null,
      approvalId ?? null,
      payload.ciphertext,
      payload.nonce,
      payload.tag,
      maxAttempts,
      now,
      now,
    )
    this.appendEvent(actionId, 'created', { status, approvalId: approvalId ?? null })
    return this.get(actionId)
  }

  get(actionId: string): ActionRecord {
    const row = this.database.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as ActionRow | undefined
    if (row === undefined) throw new Error(`Unknown action: ${actionId}`)
    return this.toAction(row)
  }

  findByIdempotencyKey(idempotencyKey: string): ActionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM actions WHERE idempotency_key = ?').get(idempotencyKey) as ActionRow | undefined
    return row === undefined ? undefined : this.toAction(row)
  }

  findByApprovalId(approvalId: string): ActionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM actions WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(approvalId) as ActionRow | undefined
    return row === undefined ? undefined : this.toAction(row)
  }

  list(): ActionRecord[] {
    const rows = this.database.prepare('SELECT * FROM actions ORDER BY updated_at DESC, id DESC').all() as unknown as ActionRow[]
    return rows.map((row) => this.toAction(row))
  }

  due(now = new Date().toISOString()): ActionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM actions
      WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC, id ASC
    `).all(now) as unknown as ActionRow[]
    return rows.map((row) => this.toAction(row))
  }

  claim(actionId: string, now = new Date().toISOString()): ActionRecord | undefined {
    const result = this.database.prepare(`
      UPDATE actions
      SET status = 'running', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, actionId)
    if (Number(result.changes) === 0) return undefined
    this.appendEvent(actionId, 'started', { attemptedAt: now })
    return this.get(actionId)
  }

  succeed(actionId: string, result: unknown, now = new Date().toISOString()): ActionRecord {
    const encrypted = this.cipher.encrypt(result, actionAssociatedData(actionId, 'result'))
    this.database.prepare(`
      UPDATE actions
      SET status = 'succeeded', result_ciphertext = ?, result_nonce = ?, result_tag = ?,
          last_error_ciphertext = NULL, last_error_nonce = NULL, last_error_tag = NULL,
          next_attempt_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now, actionId)
    this.appendEvent(actionId, 'succeeded', { result })
    return this.get(actionId)
  }

  fail(
    actionId: string,
    error: string,
    retryAt: string | undefined,
    now = new Date().toISOString(),
  ): ActionRecord {
    const action = this.get(actionId)
    const encrypted = this.cipher.encrypt(error, actionAssociatedData(actionId, 'last-error'))
    const terminal = retryAt === undefined || action.attempts >= action.maxAttempts
    this.database.prepare(`
      UPDATE actions
      SET status = ?, last_error_ciphertext = ?, last_error_nonce = ?, last_error_tag = ?,
          next_attempt_at = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      terminal ? 'failed' : 'queued',
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      terminal ? null : retryAt,
      now,
      terminal ? now : null,
      actionId,
    )
    this.appendEvent(actionId, terminal ? 'failed' : 'retry_scheduled', { error, retryAt: retryAt ?? null })
    return this.get(actionId)
  }

  queueAfterApproval(actionId: string, now = new Date().toISOString()): ActionRecord {
    const action = this.get(actionId)
    if (action.status !== 'pending_approval') return action
    this.database.prepare(`
      UPDATE actions SET status = 'queued', next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_approval'
    `).run(now, now, actionId)
    this.appendEvent(actionId, 'approval_granted', {})
    return this.get(actionId)
  }

  cancel(actionId: string, reason: string, now = new Date().toISOString()): ActionRecord {
    const action = this.get(actionId)
    if (action.status === 'succeeded' || action.status === 'cancelled') return action
    const encrypted = this.cipher.encrypt(reason, actionAssociatedData(actionId, 'last-error'))
    this.database.prepare(`
      UPDATE actions
      SET status = 'cancelled', last_error_ciphertext = ?, last_error_nonce = ?, last_error_tag = ?,
          next_attempt_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now, actionId)
    this.appendEvent(actionId, 'cancelled', { reason })
    return this.get(actionId)
  }

  retry(actionId: string, now = new Date().toISOString()): ActionRecord {
    const action = this.get(actionId)
    if (action.status !== 'failed') throw new Error(`Only a failed action can retry, not ${action.status}`)
    this.database.prepare(`
      UPDATE actions
      SET status = 'queued', attempts = 0, next_attempt_at = ?, updated_at = ?, completed_at = NULL
      WHERE id = ?
    `).run(now, now, actionId)
    this.appendEvent(actionId, 'manual_retry', {})
    return this.get(actionId)
  }

  recoverRunning(now = new Date().toISOString()): number {
    const rows = this.database.prepare(`SELECT id FROM actions WHERE status = 'running'`).all() as Array<{ id: string }>
    for (const row of rows) {
      this.database.prepare(`
        UPDATE actions SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, row.id)
      this.appendEvent(row.id, 'recovered', {})
    }
    return rows.length
  }

  events(actionId: string): ActionEvent[] {
    const rows = this.database.prepare(`
      SELECT * FROM action_events WHERE action_id = ? ORDER BY id ASC
    `).all(actionId) as unknown as ActionEventRow[]
    return rows.map((row) => ({
      id: row.id,
      actionId: row.action_id,
      type: row.type,
      data: this.cipher.decrypt({
        ciphertext: row.data_ciphertext,
        nonce: row.data_nonce,
        tag: row.data_tag,
      }, actionEventAssociatedData(row.action_id, row.type)),
      createdAt: row.created_at,
    }))
  }

  private appendEvent(actionId: string, type: string, data: unknown): void {
    const encrypted = this.cipher.encrypt(data, actionEventAssociatedData(actionId, type))
    this.database.prepare(`
      INSERT INTO action_events (action_id, type, data_ciphertext, data_nonce, data_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(actionId, type, encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString())
  }

  private decryptRequired(
    actionId: string,
    field: 'summary' | 'details',
    ciphertext: Uint8Array | null,
    nonce: Uint8Array | null,
    tag: Uint8Array | null,
  ): string {
    if (ciphertext === null || nonce === null || tag === null) {
      throw new Error(`Incomplete encrypted ${field} for action: ${actionId}`)
    }
    return this.cipher.decrypt({ ciphertext, nonce, tag }, actionAssociatedData(actionId, field)) as string
  }

  private toAction(row: ActionRow): ActionRecord {
    const action: ActionRecord = {
      id: row.id,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      title: row.title,
      summary: this.decryptRequired(row.id, 'summary', row.summary_ciphertext, row.summary_nonce, row.summary_tag),
      status: requireStatus(row.status),
      payload: this.cipher.decrypt({
        ciphertext: row.payload_ciphertext,
        nonce: row.payload_nonce,
        tag: row.payload_tag,
      }, actionAssociatedData(row.id, 'payload')),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.details_ciphertext !== null || row.details_nonce !== null || row.details_tag !== null) {
      action.details = this.decryptRequired(row.id, 'details', row.details_ciphertext, row.details_nonce, row.details_tag)
    }
    if (row.task_id !== null) action.taskId = row.task_id
    if (row.approval_id !== null) action.approvalId = row.approval_id
    if (row.next_attempt_at !== null) action.nextAttemptAt = row.next_attempt_at
    if (row.last_error_ciphertext !== null && row.last_error_nonce !== null && row.last_error_tag !== null) {
      action.lastError = this.cipher.decrypt({
        ciphertext: row.last_error_ciphertext,
        nonce: row.last_error_nonce,
        tag: row.last_error_tag,
      }, actionAssociatedData(row.id, 'last-error')) as string
    }
    if (row.result_ciphertext !== null && row.result_nonce !== null && row.result_tag !== null) {
      action.result = this.cipher.decrypt({
        ciphertext: row.result_ciphertext,
        nonce: row.result_nonce,
        tag: row.result_tag,
      }, actionAssociatedData(row.id, 'result'))
    }
    if (row.completed_at !== null) action.completedAt = row.completed_at
    return action
  }
}

function actionAssociatedData(actionId: string, field: 'payload' | 'summary' | 'details' | 'last-error' | 'result'): string {
  return `action:${actionId}:${field}`
}

function actionEventAssociatedData(value: string | number, type?: string): string {
  return `action-event:${value}${type === undefined ? '' : `:${type}`}`
}

function requireText(value: string, label: string, max: number): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`${label} cannot be empty`)
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`)
  return text
}

function requireStatus(value: string): ActionStatus {
  if (!STATUSES.includes(value as ActionStatus)) throw new Error(`Unknown action status: ${value}`)
  return value as ActionStatus
}
