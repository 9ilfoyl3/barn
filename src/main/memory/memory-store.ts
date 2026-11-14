import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { z } from 'zod'
import type {
  MemoryEntry,
  MemoryKind,
  MemorySaveInput,
  MemoryScope,
  MemorySettings,
} from '../../shared/models'
import type { AesGcmEventCipher } from '../session/event-cipher'

const memoryPayloadSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()),
})

type MemoryPayload = z.infer<typeof memoryPayloadSchema>

interface MemoryRow {
  id: string
  scope: MemoryScope
  workspace_hash: string
  kind: MemoryKind
  pinned: number
  confidence: number
  version: number
  payload_ciphertext: Uint8Array
  payload_nonce: Uint8Array
  payload_tag: Uint8Array
  created_at: string
  updated_at: string
  last_used_at: string | null
  use_count: number
}

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: false,
  useMemories: true,
  generateMemories: true,
  idleMinutes: 360,
  maxEntries: 500,
}

const SENSITIVE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

export class MemoryStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL,
        use_memories INTEGER NOT NULL,
        generate_memories INTEGER NOT NULL,
        idle_minutes INTEGER NOT NULL,
        max_entries INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
        workspace_hash TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        dedupe_hash TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL,
        version INTEGER NOT NULL,
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(scope, workspace_hash, kind, dedupe_hash)
      );

      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS memory_entries_status_idx
      ON memory_entries(status, scope, workspace_hash, updated_at DESC);
    `)
    this.database.prepare(`
      INSERT OR IGNORE INTO memory_settings (
        id, enabled, use_memories, generate_memories, idle_minutes, max_entries
      ) VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_SETTINGS.enabled ? 1 : 0,
      DEFAULT_SETTINGS.useMemories ? 1 : 0,
      DEFAULT_SETTINGS.generateMemories ? 1 : 0,
      DEFAULT_SETTINGS.idleMinutes,
      DEFAULT_SETTINGS.maxEntries,
    )
  }

  getSettings(): MemorySettings {
    const row = this.database.prepare(`
      SELECT enabled, use_memories, generate_memories, idle_minutes, max_entries
      FROM memory_settings WHERE id = 1
    `).get() as {
      enabled: number
      use_memories: number
      generate_memories: number
      idle_minutes: number
      max_entries: number
    } | undefined
    if (row === undefined) return { ...DEFAULT_SETTINGS }
    return {
      enabled: row.enabled === 1,
      useMemories: row.use_memories === 1,
      generateMemories: row.generate_memories === 1,
      idleMinutes: row.idle_minutes,
      maxEntries: row.max_entries,
    }
  }

  setSettings(change: Partial<MemorySettings>): MemorySettings {
    const next = normalizeSettings({ ...this.getSettings(), ...change })
    this.database.prepare(`
      UPDATE memory_settings
      SET enabled = ?, use_memories = ?, generate_memories = ?, idle_minutes = ?, max_entries = ?
      WHERE id = 1
    `).run(
      next.enabled ? 1 : 0,
      next.useMemories ? 1 : 0,
      next.generateMemories ? 1 : 0,
      next.idleMinutes,
      next.maxEntries,
    )
    return next
  }

  save(input: MemorySaveInput): MemoryEntry {
    const normalized = normalizeSaveInput(input)
    if (containsSensitiveContent(`${normalized.title}\n${normalized.content}`)) {
      throw new Error('Memory contains sensitive credentials and was not saved')
    }
    const workspaceHash = normalized.scope === 'workspace'
      ? this.workspaceHash(requireWorkspacePath(normalized.workspacePath))
      : ''
    const key = normalized.key ?? normalized.title
    const dedupeHash = this.cipher.fingerprint([
      normalized.scope,
      workspaceHash,
      normalized.kind,
      key.trim().toLowerCase(),
    ].join('\0'))
    const existing = this.database.prepare(`
      SELECT id, version, created_at FROM memory_entries
      WHERE scope = ? AND workspace_hash = ? AND kind = ? AND dedupe_hash = ? AND status = 'active'
    `).get(normalized.scope, workspaceHash, normalized.kind, dedupeHash) as {
      id: string
      version: number
      created_at: string
    } | undefined

    if (existing === undefined && this.activeCount() >= this.getSettings().maxEntries) {
      throw new Error('Memory limit reached; remove or archive memories before saving more')
    }

    const id = existing?.id ?? randomUUID()
    const version = (existing?.version ?? 0) + 1
    const now = new Date().toISOString()
    const payload: MemoryPayload = {
      key,
      title: normalized.title,
      content: normalized.content,
      tags: normalized.tags,
    }
    const encrypted = this.cipher.encrypt(payload, memoryAssociatedData(id, version))
    if (existing === undefined) {
      this.database.prepare(`
        INSERT INTO memory_entries (
          id, scope, workspace_hash, kind, status, dedupe_hash, pinned, confidence, version,
          payload_ciphertext, payload_nonce, payload_tag, created_at, updated_at, use_count
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        id,
        normalized.scope,
        workspaceHash,
        normalized.kind,
        dedupeHash,
        normalized.pinned ? 1 : 0,
        normalized.confidence,
        version,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
        now,
      )
    } else {
      this.database.prepare(`
        UPDATE memory_entries
        SET pinned = ?, confidence = ?, version = ?, payload_ciphertext = ?, payload_nonce = ?,
            payload_tag = ?, updated_at = ?
        WHERE id = ?
      `).run(
        normalized.pinned ? 1 : 0,
        normalized.confidence,
        version,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
        id,
      )
    }
    if (normalized.sourceSessionId !== undefined) {
      this.database.prepare(`
        INSERT OR IGNORE INTO memory_sources (memory_id, session_id, created_at)
        VALUES (?, ?, ?)
      `).run(id, normalized.sourceSessionId, now)
    }
    return this.get(id)
  }

  list(options: { scope?: 'all' | MemoryScope; workspacePath?: string } = {}): MemoryEntry[] {
    const scope = options.scope ?? 'all'
    const workspaceHash = options.workspacePath === undefined ? undefined : this.workspaceHash(options.workspacePath)
    const rows = this.database.prepare(`
      SELECT id, scope, workspace_hash, kind, pinned, confidence, version,
             payload_ciphertext, payload_nonce, payload_tag,
             created_at, updated_at, last_used_at, use_count
      FROM memory_entries
      WHERE status = 'active'
      ORDER BY pinned DESC, updated_at DESC
    `).all() as unknown as MemoryRow[]
    return rows
      .filter((row) => {
        if (scope === 'global') return row.scope === 'global'
        if (scope === 'workspace') {
          return row.scope === 'workspace' && (workspaceHash === undefined || row.workspace_hash === workspaceHash)
        }
        if (workspaceHash === undefined) return true
        return row.scope === 'global' || row.workspace_hash === workspaceHash
      })
      .map((row) => this.toEntry(row))
  }

  search(input: { query: string; workspacePath?: string; scope?: 'all' | MemoryScope; limit?: number }): MemoryEntry[] {
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 8)))
    const entries = this.list({
      scope: input.scope ?? 'all',
      ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
    })
    const query = input.query.trim().toLowerCase()
    if (query.length === 0) return entries.slice(0, limit)
    const terms = queryTerms(query)
    return entries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, query, terms),
      }))
      .filter(({ entry, score }) => score > 0 || entry.pinned)
      .toSorted((a, b) => b.score - a.score
        || Number(b.entry.pinned) - Number(a.entry.pinned)
        || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, limit)
      .map(({ entry }) => entry)
  }

  touch(ids: string[]): void {
    if (ids.length === 0) return
    const now = new Date().toISOString()
    const statement = this.database.prepare(`
      UPDATE memory_entries SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?
    `)
    for (const id of new Set(ids)) statement.run(now, id)
  }

  delete(id: string): void {
    const result = this.database.prepare("UPDATE memory_entries SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(new Date().toISOString(), id)
    if (result.changes === 0) throw new Error(`Unknown memory: ${id}`)
  }

  activeCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM memory_entries WHERE status = 'active'")
      .get() as { count: number }
    return Number(row.count)
  }

  private get(id: string): MemoryEntry {
    const row = this.database.prepare(`
      SELECT id, scope, workspace_hash, kind, pinned, confidence, version,
             payload_ciphertext, payload_nonce, payload_tag,
             created_at, updated_at, last_used_at, use_count
      FROM memory_entries WHERE id = ? AND status = 'active'
    `).get(id) as unknown as MemoryRow | undefined
    if (row === undefined) throw new Error(`Unknown memory: ${id}`)
    return this.toEntry(row)
  }

  private toEntry(row: MemoryRow): MemoryEntry {
    const payload = memoryPayloadSchema.parse(this.cipher.decrypt<MemoryPayload>({
      ciphertext: row.payload_ciphertext,
      nonce: row.payload_nonce,
      tag: row.payload_tag,
    }, memoryAssociatedData(row.id, row.version)))
    const sources = this.database.prepare(`
      SELECT session_id FROM memory_sources WHERE memory_id = ? ORDER BY created_at ASC
    `).all(row.id) as Array<{ session_id: string }>
    const entry: MemoryEntry = {
      id: row.id,
      scope: row.scope,
      kind: row.kind,
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
      pinned: row.pinned === 1,
      confidence: row.confidence,
      sourceSessionIds: sources.map((source) => source.session_id),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      useCount: row.use_count,
    }
    if (row.last_used_at !== null) entry.lastUsedAt = row.last_used_at
    return entry
  }

  private workspaceHash(workspacePath: string): string {
    let canonical = resolve(workspacePath)
    try {
      canonical = realpathSync.native(canonical)
    } catch {
      // A missing working directory still gets a stable lexical identity.
    }
    return this.cipher.fingerprint(`workspace:${canonical}`)
  }
}

function normalizeSaveInput(input: MemorySaveInput): MemorySaveInput & { tags: string[]; confidence: number; pinned: boolean } {
  const title = input.title.trim()
  const content = input.content.trim()
  if (title.length === 0 || title.length > 120) throw new Error('Memory title must be between 1 and 120 characters')
  if (content.length === 0 || content.length > 2_000) throw new Error('Memory content must be between 1 and 2,000 characters')
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) throw new Error('Memory tags exceed their limit')
  const confidence = input.confidence ?? 0.8
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Memory confidence must be between 0 and 1')
  return {
    ...input,
    title,
    content,
    tags,
    pinned: input.pinned ?? false,
    confidence,
    ...(input.key === undefined ? {} : { key: input.key.trim() }),
  }
}

function normalizeSettings(input: MemorySettings): MemorySettings {
  const idleMinutes = Math.max(15, Math.min(10_080, Math.floor(input.idleMinutes)))
  const maxEntries = Math.max(10, Math.min(2_000, Math.floor(input.maxEntries)))
  return { ...input, idleMinutes, maxEntries }
}

function requireWorkspacePath(path: string | undefined): string {
  if (path === undefined || path.trim().length === 0) throw new Error('Workspace memory requires a working directory')
  return path
}

function memoryAssociatedData(id: string, version: number): string {
  return `memory:${id}:${version}`
}

function containsSensitiveContent(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))
}

function queryTerms(query: string): string[] {
  const words = query.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
  const terms = new Set(words)
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 2) {
      for (let index = 0; index < word.length - 1; index++) terms.add(word.slice(index, index + 2))
    }
  }
  return [...terms]
}

function scoreEntry(entry: MemoryEntry, query: string, terms: string[]): number {
  const title = entry.title.toLowerCase()
  const content = entry.content.toLowerCase()
  const tags = entry.tags.map((tag) => tag.toLowerCase())
  let score = entry.pinned ? 15 : 0
  if (title.includes(query)) score += 30
  if (content.includes(query)) score += 15
  for (const term of terms) {
    if (matchesTerm(title, term)) score += 8
    if (tags.some((tag) => matchesTerm(tag, term))) score += 6
    if (matchesTerm(content, term)) score += 3
  }
  if (score > 0) score += Math.min(5, entry.useCount * 0.25)
  return score
}

function matchesTerm(text: string, term: string): boolean {
  if (text.includes(term)) return true
  if (!/^[a-z0-9_-]+$/i.test(term) || term.length < 5) return false
  const prefix = term.slice(0, 5)
  return text.split(/[^a-z0-9_-]+/i).some((word) => word.length >= 5 && word.startsWith(prefix))
}
