import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AesGcmEventCipher } from '../session/event-cipher'
import type {
  ApprovalRequest,
  ApprovalStatus,
  PermissionKind,
  PermissionMode,
  PermissionPolicy,
  PermissionRequestInput,
} from '../../shared/models'

const MODES: readonly PermissionMode[] = ['allow', 'ask', 'deny']
const KINDS: readonly PermissionKind[] = ['local-read', 'workspace-write', 'external-read', 'external-write', 'destructive']
const STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'denied']

interface ApprovalRow {
  id: string
  kind: string
  title: string
  summary_ciphertext: Uint8Array | null
  summary_nonce: Uint8Array | null
  summary_tag: Uint8Array | null
  details_ciphertext: Uint8Array | null
  details_nonce: Uint8Array | null
  details_tag: Uint8Array | null
  task_id: string | null
  status: string
  created_at: string
  resolved_at: string | null
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  localRead: 'allow',
  workspaceWrite: 'allow',
  externalRead: 'allow',
  externalWrite: 'ask',
  destructive: 'ask',
}

/** Persistent safety policy and approval requests, in the Desktop's encrypted-at-rest database. */
export class PermissionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS permission_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        local_read TEXT NOT NULL,
        workspace_write TEXT NOT NULL,
        external_read TEXT NOT NULL DEFAULT 'allow',
        external_write TEXT NOT NULL,
        destructive TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary_ciphertext BLOB,
        summary_nonce BLOB,
        summary_tag BLOB,
        details_ciphertext BLOB,
        details_nonce BLOB,
        details_tag BLOB,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS approvals_pending_created
        ON approvals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS approvals_task
        ON approvals(task_id);
    `)
    this.ensureApprovalCipherColumns()
    this.ensurePolicyColumns()
    this.database.prepare(`
      INSERT OR IGNORE INTO permission_policy (
        id, local_read, workspace_write, external_read, external_write, destructive
      ) VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_PERMISSION_POLICY.localRead,
      DEFAULT_PERMISSION_POLICY.workspaceWrite,
      DEFAULT_PERMISSION_POLICY.externalRead,
      DEFAULT_PERMISSION_POLICY.externalWrite,
      DEFAULT_PERMISSION_POLICY.destructive,
    )
  }

  getPolicy(): PermissionPolicy {
    const row = this.database.prepare(`
      SELECT local_read, workspace_write, external_read, external_write, destructive
      FROM permission_policy WHERE id = 1
    `).get() as {
      local_read: string
      workspace_write: string
      external_read: string
      external_write: string
      destructive: string
    } | undefined
    if (row === undefined) return { ...DEFAULT_PERMISSION_POLICY }
    return {
      localRead: requireMode(row.local_read),
      workspaceWrite: requireMode(row.workspace_write),
      externalRead: requireMode(row.external_read),
      externalWrite: requireMode(row.external_write),
      destructive: requireMode(row.destructive),
    }
  }

  setPolicy(policy: PermissionPolicy): PermissionPolicy {
    const validated = {
      localRead: requireMode(policy.localRead),
      workspaceWrite: requireMode(policy.workspaceWrite),
      externalRead: requireMode(policy.externalRead),
      externalWrite: requireMode(policy.externalWrite),
      destructive: requireMode(policy.destructive),
    }
    this.database.prepare(`
      UPDATE permission_policy
      SET local_read = ?, workspace_write = ?, external_write = ?, destructive = ?
      WHERE id = 1
    `).run(validated.localRead, validated.workspaceWrite, validated.externalWrite, validated.destructive)
    return validated
  }

  createApproval(input: PermissionRequestInput, approvalId: string = randomUUID()): ApprovalRequest {
    requireKind(input.kind)
    const title = requireText(input.title, 'Approval title', 200)
    const summary = requireText(input.summary, 'Approval summary', 2_000)
    const details = input.details === undefined ? undefined : requireText(input.details, 'Approval details', 20_000)
    const now = new Date().toISOString()
    const encryptedSummary = this.cipher.encrypt(summary, approvalAssociatedData(approvalId, 'summary'))
    const encryptedDetails = details === undefined
      ? undefined
      : this.cipher.encrypt(details, approvalAssociatedData(approvalId, 'details'))
    this.database.prepare(`
      INSERT INTO approvals (
        id, kind, title,
        summary_ciphertext, summary_nonce, summary_tag,
        details_ciphertext, details_nonce, details_tag,
        task_id, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run(
      approvalId,
      input.kind,
      title,
      encryptedSummary.ciphertext,
      encryptedSummary.nonce,
      encryptedSummary.tag,
      encryptedDetails?.ciphertext ?? null,
      encryptedDetails?.nonce ?? null,
      encryptedDetails?.tag ?? null,
      input.taskId ?? null,
      now,
    )
    return this.get(approvalId)
  }

  get(approvalId: string): ApprovalRequest {
    const row = this.database.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined
    if (row === undefined) throw new Error(`Unknown approval: ${approvalId}`)
    return this.toApproval(row)
  }

  listPending(): ApprovalRequest[] {
    const rows = this.database.prepare(`
      SELECT * FROM approvals WHERE status = 'pending'
      ORDER BY created_at DESC, id DESC
    `).all() as unknown as ApprovalRow[]
    return rows.map((row) => this.toApproval(row))
  }

  resolve(approvalId: string, decision: 'approved' | 'denied'): ApprovalRequest {
    const current = this.get(approvalId)
    if (current.status !== 'pending') throw new Error(`Approval is already ${current.status}`)
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(decision, now, approvalId)
    return this.get(approvalId)
  }

  private toApproval(row: ApprovalRow): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: row.id,
      kind: requireKind(row.kind),
      title: row.title,
      summary: this.decryptField(row.id, 'summary', row.summary_ciphertext, row.summary_nonce, row.summary_tag),
      status: requireStatus(row.status),
      createdAt: row.created_at,
    }
    if (row.details_ciphertext !== null || row.details_nonce !== null || row.details_tag !== null) {
      approval.details = this.decryptField(row.id, 'details', row.details_ciphertext, row.details_nonce, row.details_tag)
    }
    if (row.task_id !== null) approval.taskId = row.task_id
    if (row.resolved_at !== null) approval.resolvedAt = row.resolved_at
    return approval
  }

  private decryptField(
    approvalId: string,
    field: 'summary' | 'details',
    ciphertext: Uint8Array | null,
    nonce: Uint8Array | null,
    tag: Uint8Array | null,
  ): string {
    if (ciphertext === null || nonce === null || tag === null) {
      throw new Error(`Incomplete encrypted ${field} for approval: ${approvalId}`)
    }
    return this.cipher.decrypt({ ciphertext, nonce, tag }, approvalAssociatedData(approvalId, field)) as string
  }

  private ensurePolicyColumns(): void {
    const columns = new Set(
      (this.database.prepare('PRAGMA table_info(permission_policy)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    )
    if (!columns.has('external_read')) {
      this.database.exec("ALTER TABLE permission_policy ADD COLUMN external_read TEXT NOT NULL DEFAULT 'allow'")
    }
  }

  private ensureApprovalCipherColumns(): void {
    const columns = new Set((this.database.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>)
      .map((column) => column.name))
    const additions = [
      ['summary_ciphertext', 'BLOB'],
      ['summary_nonce', 'BLOB'],
      ['summary_tag', 'BLOB'],
      ['details_ciphertext', 'BLOB'],
      ['details_nonce', 'BLOB'],
      ['details_tag', 'BLOB'],
    ] as const
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE approvals ADD COLUMN ${name} ${type}`)
    }
  }
}

function approvalAssociatedData(approvalId: string, field: 'summary' | 'details'): string {
  return `approval:${approvalId}:${field}`
}

function requireMode(value: string): PermissionMode {
  if (!MODES.includes(value as PermissionMode)) throw new Error(`Unknown permission mode: ${value}`)
  return value as PermissionMode
}

function requireKind(value: string): PermissionKind {
  if (!KINDS.includes(value as PermissionKind)) throw new Error(`Unknown permission kind: ${value}`)
  return value as PermissionKind
}

function requireStatus(value: string): ApprovalStatus {
  if (!STATUSES.includes(value as ApprovalStatus)) throw new Error(`Unknown approval status: ${value}`)
  return value as ApprovalStatus
}

function requireText(value: string, label: string, max: number): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`${label} cannot be empty`)
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`)
  return text
}
