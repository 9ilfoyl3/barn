import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  RouterDecisionKind,
  RouterRequest,
  RouterRequestStatus,
  RouterSnapshot,
  VisibleMessage,
} from '../../shared/models'

const STATUSES: readonly RouterRequestStatus[] = ['queued', 'routing', 'completed', 'failed', 'cancelled']
const DECISION_KINDS: readonly RouterDecisionKind[] = [
  'reply',
  'clarify',
  'create_task',
  'update_task',
  'cancel_task',
  'answer_task',
]
const DEFAULT_LIMIT = 200

interface RouterRequestRow {
  id: string
  thread_id: string
  user_message_id: string
  sequence: number
  priority: number
  status: string
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
  decision_kind: string | null
  task_id: string | null
  reply_message_id: string | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export interface RouterAcceptInput {
  requestId?: string
  threadId: string
  userMessage: VisibleMessage
  priority?: number
}

export interface RouterDecisionInput {
  kind: RouterDecisionKind
  confidence: number
  rationaleCodes: string[]
  taskId?: string
  replyMessageId?: string
}

export interface ClaimedRouterRequest {
  request: RouterRequest
  leaseOwner: string
}

/** Durable admission queue for the serial Router lane. */
export class RouterStore {
  constructor(private readonly database: DatabaseSync) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS router_requests (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        decision_kind TEXT,
        task_id TEXT,
        reply_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS router_requests_lane
        ON router_requests(status, priority DESC, sequence ASC);

      CREATE TABLE IF NOT EXISTS router_decisions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES router_requests(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale_codes_json TEXT NOT NULL,
        task_id TEXT,
        reply_message_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS router_decisions_request
        ON router_decisions(request_id, created_at DESC);
    `)
  }

  accept(input: RouterAcceptInput): RouterRequest {
    const existing = this.findByUserMessage(input.userMessage.id)
    if (existing !== undefined) return existing
    const now = new Date().toISOString()
    const request: RouterRequest = {
      id: input.requestId ?? randomUUID(),
      threadId: input.threadId,
      userMessageId: input.userMessage.id,
      sequence: input.userMessage.seq,
      priority: normalizePriority(input.priority),
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.database.prepare(`
      INSERT INTO router_requests (
        id, thread_id, user_message_id, sequence, priority, status,
        attempt_count, lease_owner, lease_expires_at, decision_kind,
        task_id, reply_message_id, error, created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
    `).run(
      request.id,
      request.threadId,
      request.userMessageId,
      request.sequence,
      request.priority,
      now,
      now,
    )
    return request
  }

  findByUserMessage(userMessageId: string): RouterRequest | undefined {
    const row = this.database.prepare(`
      SELECT * FROM router_requests WHERE user_message_id = ?
    `).get(userMessageId) as RouterRequestRow | undefined
    return row === undefined ? undefined : toRouterRequest(row)
  }

  get(requestId: string): RouterRequest {
    const row = this.database.prepare('SELECT * FROM router_requests WHERE id = ?')
      .get(requestId) as RouterRequestRow | undefined
    if (row === undefined) throw new Error(`Unknown Router request: ${requestId}`)
    return toRouterRequest(row)
  }

  list(limit = DEFAULT_LIMIT): RouterRequest[] {
    const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const rows = this.database.prepare(`
      SELECT * FROM router_requests
      ORDER BY sequence DESC
      LIMIT ?
    `).all(bounded) as unknown as RouterRequestRow[]
    return rows.toReversed().map(toRouterRequest)
  }

  snapshot(): RouterSnapshot {
    const requests = this.list()
    const active = requests.find((request) => request.status === 'routing')
    return {
      requests,
      queuedCount: requests.filter((request) => request.status === 'queued').length,
      ...(active === undefined ? {} : { activeRequest: active }),
    }
  }

  recoverExpired(now = new Date()): RouterRequest[] {
    const recovered: RouterRequest[] = []
    const rows = this.database.prepare(`
      SELECT id, lease_expires_at FROM router_requests WHERE status = 'routing'
    `).all() as Array<{ id: string; lease_expires_at: string | null }>
    for (const row of rows) {
      if (row.lease_expires_at !== null && row.lease_expires_at > now.toISOString()) continue
      const updatedAt = now.toISOString()
      this.database.prepare(`
        UPDATE router_requests
        SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
            error = 'Router lease expired; request returned to the queue.', updated_at = ?
        WHERE id = ? AND status = 'routing'
      `).run(updatedAt, row.id)
      recovered.push(this.get(row.id))
    }
    return recovered
  }

  claimNext(owner: string, leaseMs: number, now = new Date()): ClaimedRouterRequest | undefined {
    const leaseOwner = owner.trim()
    if (leaseOwner.length === 0) throw new Error('Router lease owner is required')
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error('Router lease must be at least one second')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.recoverExpired(now)
      const active = this.database.prepare(`
        SELECT 1 AS found FROM router_requests WHERE status = 'routing' LIMIT 1
      `).get() as { found: number } | undefined
      if (active !== undefined) {
        this.database.exec('COMMIT')
        return undefined
      }

      const next = this.database.prepare(`
        SELECT * FROM router_requests
        WHERE status = 'queued'
        ORDER BY priority DESC, sequence ASC
        LIMIT 1
      `).get() as RouterRequestRow | undefined
      if (next === undefined) {
        this.database.exec('COMMIT')
        return undefined
      }

      const startedAt = now.toISOString()
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
      this.database.prepare(`
        UPDATE router_requests
        SET status = 'routing', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
            error = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(leaseOwner, leaseExpiresAt, startedAt, startedAt, next.id)
      const request = this.get(next.id)
      this.database.exec('COMMIT')
      return { request, leaseOwner }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  complete(requestId: string, decision: RouterDecisionInput, now = new Date()): RouterRequest {
    const request = this.get(requestId)
    const timestamp = now.toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO router_decisions (
          id, request_id, attempt, kind, confidence, rationale_codes_json,
          task_id, reply_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        request.id,
        request.attemptCount,
        decision.kind,
        normalizeConfidence(decision.confidence),
        JSON.stringify([...new Set(decision.rationaleCodes.map((code) => code.trim()).filter(Boolean))]),
        decision.taskId ?? null,
        decision.replyMessageId ?? null,
        timestamp,
      )
      this.database.prepare(`
        UPDATE router_requests
        SET status = 'completed', decision_kind = ?, task_id = ?, reply_message_id = ?,
            lease_owner = NULL, lease_expires_at = NULL, error = NULL,
            updated_at = ?, finished_at = ?
        WHERE id = ?
      `).run(
        decision.kind,
        decision.taskId ?? null,
        decision.replyMessageId ?? null,
        timestamp,
        timestamp,
        request.id,
      )
      this.database.exec('COMMIT')
      return this.get(request.id)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  fail(requestId: string, error: string, now = new Date()): RouterRequest {
    this.get(requestId)
    const timestamp = now.toISOString()
    this.database.prepare(`
      UPDATE router_requests
      SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          error = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(error.slice(0, 2_000), timestamp, timestamp, requestId)
    return this.get(requestId)
  }

  cancel(requestId: string, now = new Date()): RouterRequest {
    const request = this.get(requestId)
    if (request.status === 'completed' || request.status === 'failed' || request.status === 'cancelled') {
      return request
    }
    const timestamp = now.toISOString()
    this.database.prepare(`
      UPDATE router_requests
      SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          error = NULL, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, requestId)
    return this.get(requestId)
  }
}

function toRouterRequest(row: RouterRequestRow): RouterRequest {
  if (!STATUSES.includes(row.status as RouterRequestStatus)) throw new Error(`Unknown Router request status: ${row.status}`)
  const request: RouterRequest = {
    id: row.id,
    threadId: row.thread_id,
    userMessageId: row.user_message_id,
    sequence: row.sequence,
    priority: row.priority,
    status: row.status as RouterRequestStatus,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.decision_kind !== null) {
    if (!DECISION_KINDS.includes(row.decision_kind as RouterDecisionKind)) {
      throw new Error(`Unknown Router decision kind: ${row.decision_kind}`)
    }
    request.decisionKind = row.decision_kind as RouterDecisionKind
  }
  if (row.task_id !== null) request.taskId = row.task_id
  if (row.reply_message_id !== null) request.replyMessageId = row.reply_message_id
  if (row.error !== null) request.error = row.error
  if (row.started_at !== null) request.startedAt = row.started_at
  if (row.finished_at !== null) request.finishedAt = row.finished_at
  return request
}

function normalizePriority(priority: number | undefined): number {
  if (priority === undefined) return 0
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
    throw new Error('Router priority must be an integer between -100 and 100')
  }
  return priority
}

function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Router decision confidence must be between 0 and 1')
  }
  return confidence
}
