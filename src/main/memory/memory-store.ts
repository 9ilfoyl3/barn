import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { z } from 'zod'
import type {
  MemoryEntry,
  MemoryDocument,
  MemoryDocumentName,
  MemoryDocumentRevision,
  MemoryKind,
  MemorySaveInput,
  MemoryScope,
  MemorySettings,
  MemorySessionControls,
  MemoryExtractionCandidate,
  MemoryExtractionState,
  MemorySourceAuthority,
  MemoryStatus,
  MemoryUpdateInput,
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
  status: MemoryStatus
  dedupe_hash: string
  pinned: number
  confidence: number
  version: number
  source_authority: MemorySourceAuthority
  source_refs_json: string
  supersedes_id: string | null
  valid_until: string | null
  last_confirmed_at: string | null
  payload_ciphertext: Uint8Array
  payload_nonce: Uint8Array
  payload_tag: Uint8Array
  created_at: string
  updated_at: string
  last_used_at: string | null
  use_count: number
}

const MEMORY_COLUMNS = `id, scope, workspace_hash, kind, status, dedupe_hash, pinned, confidence, version,
  source_authority, source_refs_json, supersedes_id, valid_until, last_confirmed_at,
  payload_ciphertext, payload_nonce, payload_tag, created_at, updated_at, last_used_at, use_count`

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: false,
  useMemories: true,
  generateMemories: true,
  idleMinutes: 360,
  maxEntries: 500,
  memoryCharLimit: 2_200,
  userCharLimit: 2_200,
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
        max_entries INTEGER NOT NULL,
        memory_char_limit INTEGER NOT NULL DEFAULT 2200,
        user_char_limit INTEGER NOT NULL DEFAULT 2200
      );

      CREATE TABLE IF NOT EXISTS memory_documents (
        name TEXT PRIMARY KEY CHECK (name IN ('memory', 'user')),
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_document_revisions (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (name, version)
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
        source_authority TEXT NOT NULL DEFAULT 'explicit',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        supersedes_id TEXT,
        valid_until TEXT,
        last_confirmed_at TEXT,
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

      CREATE TABLE IF NOT EXISTS memory_session_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        last_processed_seq INTEGER NOT NULL DEFAULT 0,
        last_processed_at TEXT,
        last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        use_memories INTEGER NOT NULL DEFAULT 1,
        generate_memories INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS memory_thread_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_processed_seq INTEGER NOT NULL DEFAULT 0,
        last_processed_at TEXT,
        last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_history (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        source_authority TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        valid_until TEXT,
        payload_ciphertext BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        payload_tag BLOB NOT NULL,
        archived_at TEXT NOT NULL,
        UNIQUE(memory_id, version)
      );
    `)
    this.ensureOptionalColumns()
    this.ensureSettingsColumns()
    this.ensureDocumentColumns()
    this.database.prepare(`
      INSERT OR IGNORE INTO memory_thread_state (id, last_processed_seq, attempts)
      VALUES (1, 0, 0)
    `).run()
    this.database.prepare(`
      INSERT OR IGNORE INTO memory_settings (
        id, enabled, use_memories, generate_memories, idle_minutes, max_entries,
        memory_char_limit, user_char_limit
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_SETTINGS.enabled ? 1 : 0,
      DEFAULT_SETTINGS.useMemories ? 1 : 0,
      DEFAULT_SETTINGS.generateMemories ? 1 : 0,
      DEFAULT_SETTINGS.idleMinutes,
      DEFAULT_SETTINGS.maxEntries,
      DEFAULT_SETTINGS.memoryCharLimit,
      DEFAULT_SETTINGS.userCharLimit,
    )
  }

  getSettings(): MemorySettings {
    const row = this.database.prepare(`
      SELECT enabled, use_memories, generate_memories, idle_minutes, max_entries,
             memory_char_limit, user_char_limit
      FROM memory_settings WHERE id = 1
    `).get() as {
      enabled: number
      use_memories: number
      generate_memories: number
      idle_minutes: number
      max_entries: number
      memory_char_limit: number
      user_char_limit: number
    } | undefined
    if (row === undefined) return { ...DEFAULT_SETTINGS }
    return {
      enabled: row.enabled === 1,
      useMemories: row.use_memories === 1,
      generateMemories: row.generate_memories === 1,
      idleMinutes: row.idle_minutes,
      maxEntries: row.max_entries,
      memoryCharLimit: row.memory_char_limit,
      userCharLimit: row.user_char_limit,
    }
  }

  setSettings(change: Partial<MemorySettings>): MemorySettings {
    const next = normalizeSettings({ ...this.getSettings(), ...change })
    this.database.prepare(`
      UPDATE memory_settings
      SET enabled = ?, use_memories = ?, generate_memories = ?, idle_minutes = ?, max_entries = ?,
          memory_char_limit = ?, user_char_limit = ?
      WHERE id = 1
    `).run(
      next.enabled ? 1 : 0,
      next.useMemories ? 1 : 0,
      next.generateMemories ? 1 : 0,
      next.idleMinutes,
      next.maxEntries,
      next.memoryCharLimit,
      next.userCharLimit,
    )
    return next
  }

  getDocument(name: MemoryDocumentName): MemoryDocument {
    const settings = this.getSettings()
    const row = this.database.prepare(`
      SELECT payload_ciphertext, payload_nonce, payload_tag, version, updated_at
      FROM memory_documents WHERE name = ?
    `).get(name) as {
      payload_ciphertext: Uint8Array
      payload_nonce: Uint8Array
      payload_tag: Uint8Array
      version: number
      updated_at: string
    } | undefined
    return {
      name,
      content: row === undefined
        ? ''
        : this.cipher.decrypt<{ content: string }>({
            ciphertext: row.payload_ciphertext,
            nonce: row.payload_nonce,
            tag: row.payload_tag,
          }, documentAssociatedData(name)).content,
      charLimit: name === 'memory' ? settings.memoryCharLimit : settings.userCharLimit,
      version: row?.version ?? 0,
      ...(row === undefined ? {} : { updatedAt: row.updated_at }),
    }
  }

  listDocumentRevisions(name: MemoryDocumentName): MemoryDocumentRevision[] {
    const rows = this.database.prepare(`
      SELECT version, payload_ciphertext, payload_nonce, payload_tag, archived_at
      FROM memory_document_revisions
      WHERE name = ?
      ORDER BY version DESC
    `).all(name) as Array<{
      version: number
      payload_ciphertext: Uint8Array
      payload_nonce: Uint8Array
      payload_tag: Uint8Array
      archived_at: string
    }>
    return rows.map((row) => ({
      name,
      version: row.version,
      content: this.cipher.decrypt<{ content: string }>({
        ciphertext: row.payload_ciphertext,
        nonce: row.payload_nonce,
        tag: row.payload_tag,
      }, documentAssociatedData(name)).content,
      archivedAt: row.archived_at,
    }))
  }

  saveDocument(name: MemoryDocumentName, content: string, expectedVersion?: number): MemoryDocument {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.saveDocumentInTransaction(name, content, expectedVersion)
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private saveDocumentInTransaction(
    name: MemoryDocumentName,
    content: string,
    expectedVersion?: number,
  ): MemoryDocument {
    const settings = this.getSettings()
    const charLimit = name === 'memory' ? settings.memoryCharLimit : settings.userCharLimit
    const charCount = Array.from(content).length
    if (charCount > charLimit) {
      throw new Error(`The ${name === 'memory' ? 'MEMORY.md' : 'USER.md'} content exceeds its ${charLimit.toLocaleString()} character limit`)
    }
    if (containsSensitiveContent(content)) {
      throw new Error('Memory documents cannot contain credentials or secrets')
    }
    const existing = this.database.prepare(`
      SELECT payload_ciphertext, payload_nonce, payload_tag, version, updated_at
      FROM memory_documents WHERE name = ?
    `).get(name) as {
      payload_ciphertext: Uint8Array
      payload_nonce: Uint8Array
      payload_tag: Uint8Array
      version: number
      updated_at: string
    } | undefined
    const currentVersion = existing?.version ?? 0
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new Error('The memory document changed in another place; reload it before saving')
    }
    const version = currentVersion + 1
    if (existing !== undefined) {
      this.database.prepare(`
        INSERT OR IGNORE INTO memory_document_revisions (
          name, version, payload_ciphertext, payload_nonce, payload_tag, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        name,
        existing.version,
        existing.payload_ciphertext,
        existing.payload_nonce,
        existing.payload_tag,
        existing.updated_at,
      )
    }
    const encrypted = this.cipher.encrypt({ content }, documentAssociatedData(name))
    const updatedAt = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO memory_documents (name, payload_ciphertext, payload_nonce, payload_tag, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        payload_ciphertext = excluded.payload_ciphertext,
        payload_nonce = excluded.payload_nonce,
        payload_tag = excluded.payload_tag,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(name, encrypted.ciphertext, encrypted.nonce, encrypted.tag, version, updatedAt)
    return { name, content, charLimit, version, updatedAt }
  }

  save(input: MemorySaveInput): MemoryEntry {
    const title = normalizeMemoryTitle(input.title)
    const content = normalizeMemoryContent(input.content)
    const requestedTags = input.tags === undefined ? undefined : normalizeMemoryTags(input.tags)
    const requestedConfidence = input.confidence === undefined ? undefined : normalizeMemoryConfidence(input.confidence)
    if (containsSensitiveContent(`${title}\n${content}`)) {
      throw new Error('Memory contains sensitive credentials and was not saved')
    }
    const workspaceHash = input.scope === 'workspace'
      ? this.workspaceHash(requireWorkspacePath(input.workspacePath))
      : ''
    const key = (input.key ?? title).trim()
    if (key.length === 0 || key.length > 100) throw new Error('Memory key must be between 1 and 100 characters')
    const baseDedupeHash = this.memoryBaseDedupeHash(input.scope, workspaceHash, input.kind, key)
    const status = input.status ?? 'active'
    const sourceAuthority = input.sourceAuthority ?? 'explicit'
    const sourceRefs = normalizeSourceRefs(input.sourceRefs ?? [])
    const existing = this.findMemoryByDedupe(baseDedupeHash, input.scope, workspaceHash, input.kind)
    if (existing !== undefined && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new Error('Memory changed in another place; reload it before saving')
    }
    if (existing?.status === 'active' && status === 'candidate') {
      const existingPayload = this.decryptPayload(existing)
      if (normalizeForComparison(existingPayload.content) === normalizeForComparison(content)) {
        this.mergeMemorySources(existing, sourceRefs, input.sourceSessionId)
        return this.get(existing.id)
      }
      const candidateHash = this.memoryCandidateDedupeHash(baseDedupeHash, content)
      const conflicting = this.findMemoryByDedupe(candidateHash, input.scope, workspaceHash, input.kind)
      return this.writeMemoryRow({
        ...(conflicting === undefined ? {} : { existing: conflicting }),
        title,
        content,
        key,
        tags: requestedTags ?? [],
        pinned: input.pinned ?? false,
        confidence: requestedConfidence ?? 0.8,
        status: 'candidate',
        sourceAuthority,
        sourceRefs,
        validUntil: input.validUntil ?? null,
        dedupeHash: candidateHash,
        scope: input.scope,
        workspaceHash,
        kind: input.kind,
        ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
        ...(conflicting === undefined ? {} : { expectedVersion: conflicting.version }),
      })
    }

    if (existing?.status === 'active' && sourceAuthorityRank(existing.source_authority) > sourceAuthorityRank(sourceAuthority)) {
      throw new Error('A higher-authority memory already exists for this key')
    }

    if (existing === undefined && status === 'active' && this.activeCount() >= this.getSettings().maxEntries) {
      throw new Error('Memory limit reached; remove or archive memories before saving more')
    }
    const existingPayload = existing === undefined ? undefined : this.decryptPayload(existing)
    return this.writeMemoryRow({
      ...(existing === undefined ? {} : { existing }),
      title,
      content,
      key,
      tags: requestedTags ?? existingPayload?.tags ?? [],
      pinned: input.pinned ?? existing?.pinned === 1,
      confidence: requestedConfidence ?? existing?.confidence ?? 0.8,
      status,
      sourceAuthority,
      sourceRefs: normalizeSourceRefs([
        ...(existing === undefined ? [] : parseSourceRefs(existing.source_refs_json)),
        ...sourceRefs,
      ]),
      validUntil: input.validUntil !== undefined ? input.validUntil : existing?.valid_until ?? null,
      dedupeHash: baseDedupeHash,
      scope: input.scope,
      workspaceHash,
      kind: input.kind,
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    })
  }

  update(input: MemoryUpdateInput): MemoryEntry {
    const row = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id = ?
    `).get(input.id) as unknown as MemoryRow | undefined
    if (row === undefined) throw new Error(`Unknown memory: ${input.id}`)
    if (row.version !== input.expectedVersion) throw new Error('Memory changed in another place; reload it before saving')
    const payload = this.decryptPayload(row)
    const title = input.title === undefined ? payload.title : normalizeMemoryTitle(input.title)
    const content = input.content === undefined ? payload.content : normalizeMemoryContent(input.content)
    const tags = input.tags === undefined ? payload.tags : normalizeMemoryTags(input.tags)
    const confidence = input.confidence === undefined ? row.confidence : normalizeMemoryConfidence(input.confidence)
    if (containsSensitiveContent(`${title}\n${content}`)) {
      throw new Error('Memory contains sensitive credentials and was not saved')
    }
    return this.writeMemoryRow({
      existing: row,
      title,
      content,
      key: payload.key,
      tags,
      pinned: input.pinned ?? row.pinned === 1,
      confidence,
      status: row.status,
      sourceAuthority: row.source_authority,
      sourceRefs: parseSourceRefs(row.source_refs_json),
      validUntil: input.validUntil === undefined ? row.valid_until : input.validUntil,
      dedupeHash: row.dedupe_hash,
      scope: row.scope,
      workspaceHash: row.workspace_hash,
      kind: row.kind,
      expectedVersion: input.expectedVersion,
    })
  }

  private writeMemoryRow(input: {
    existing?: MemoryRow
    title: string
    content: string
    key: string
    tags: string[]
    pinned: boolean
    confidence: number
    status: MemoryStatus
    sourceAuthority: MemorySourceAuthority
    sourceRefs: string[]
    validUntil: string | null
    dedupeHash: string
    scope: MemoryScope
    workspaceHash: string
    kind: MemoryKind
    sourceSessionId?: string
    expectedVersion?: number
  }): MemoryEntry {
    if (input.existing !== undefined && input.expectedVersion !== undefined && input.existing.version !== input.expectedVersion) {
      throw new Error('Memory changed in another place; reload it before saving')
    }
    if (input.existing === undefined && input.status === 'active' && this.activeCount() >= this.getSettings().maxEntries) {
      throw new Error('Memory limit reached; remove or archive memories before saving more')
    }
    const id = input.existing?.id ?? randomUUID()
    const version = (input.existing?.version ?? 0) + 1
    const now = new Date().toISOString()
    const lastConfirmedAt = input.status === 'active' ? now : null
    const previousRevisionId = input.existing === undefined ? null : this.archiveHistory(input.existing, now)
    const payload: MemoryPayload = {
      key: input.key,
      title: input.title,
      content: input.content,
      tags: input.tags,
    }
    const encrypted = this.cipher.encrypt(payload, memoryAssociatedData(id, version))
    const sourceRefsJson = JSON.stringify(normalizeSourceRefs(input.sourceRefs))
    if (input.existing === undefined) {
      this.database.prepare(`
        INSERT INTO memory_entries (
          id, scope, workspace_hash, kind, status, dedupe_hash, pinned, confidence, version,
          source_authority, source_refs_json, supersedes_id, valid_until, last_confirmed_at,
          payload_ciphertext, payload_nonce, payload_tag, created_at, updated_at, use_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        id,
        input.scope,
        input.workspaceHash,
        input.kind,
        input.status,
        input.dedupeHash,
        input.pinned ? 1 : 0,
        input.confidence,
        version,
        input.sourceAuthority,
        sourceRefsJson,
        input.validUntil,
        lastConfirmedAt,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
        now,
      )
    } else {
      this.database.prepare(`
        UPDATE memory_entries
        SET status = ?, dedupe_hash = ?, pinned = ?, confidence = ?, version = ?, source_authority = ?,
            source_refs_json = ?, supersedes_id = ?, valid_until = ?, last_confirmed_at = ?,
            payload_ciphertext = ?, payload_nonce = ?, payload_tag = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.status,
        input.dedupeHash,
        input.pinned ? 1 : 0,
        input.confidence,
        version,
        input.sourceAuthority,
        sourceRefsJson,
        previousRevisionId,
        input.validUntil,
        lastConfirmedAt,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
        id,
      )
    }
    if (input.sourceSessionId !== undefined) {
      this.database.prepare(`
        INSERT OR IGNORE INTO memory_sources (memory_id, session_id, created_at)
        VALUES (?, ?, ?)
      `).run(id, input.sourceSessionId, now)
    }
    return this.get(id)
  }

  list(options: { scope?: 'all' | MemoryScope; workspacePath?: string } = {}): MemoryEntry[] {
    const scope = options.scope ?? 'all'
    const workspaceHash = options.workspacePath === undefined ? undefined : this.workspaceHash(options.workspacePath)
    const now = new Date().toISOString()
    const rows = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memory_entries
      WHERE status = 'active'
        AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY pinned DESC, updated_at DESC
    `).all(now) as unknown as MemoryRow[]
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

  listCandidates(): MemoryEntry[] {
    const rows = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memory_entries
      WHERE status = 'candidate'
      ORDER BY updated_at DESC
    `).all() as unknown as MemoryRow[]
    return rows.map((row) => this.toEntry(row))
  }

  confirm(id: string): MemoryEntry {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database.prepare(`
        SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id = ?
      `).get(id) as unknown as MemoryRow | undefined
      if (row === undefined || row.status !== 'candidate') throw new Error(`Unknown memory candidate: ${id}`)
      const payload = this.decryptPayload(row)
      const baseDedupeHash = this.memoryBaseDedupeHash(row.scope, row.workspace_hash, row.kind, payload.key)
      const active = this.database.prepare(`
        SELECT ${MEMORY_COLUMNS} FROM memory_entries
        WHERE status = 'active' AND scope = ? AND workspace_hash = ? AND kind = ? AND dedupe_hash = ?
      `).get(row.scope, row.workspace_hash, row.kind, baseDedupeHash) as unknown as MemoryRow | undefined
      if (active === undefined && this.activeCount() >= this.getSettings().maxEntries) {
        throw new Error('Memory limit reached; remove or archive memories before confirming another one')
      }
      const now = new Date().toISOString()
      const candidateRevisionId = this.archiveHistory(row, now)
      let supersedesId = candidateRevisionId
      if (active !== undefined) {
        const activeRevisionId = this.archiveHistory(active, now)
        const supersededHash = this.cipher.fingerprint(`${baseDedupeHash}\0superseded\0${active.version}`)
        this.database.prepare(`
          UPDATE memory_entries
          SET status = 'superseded', dedupe_hash = ?, supersedes_id = ?, updated_at = ?
          WHERE id = ?
        `).run(supersededHash, activeRevisionId, now, active.id)
        supersedesId = activeRevisionId
      }
      const version = row.version + 1
      const encrypted = this.cipher.encrypt(payload, memoryAssociatedData(row.id, version))
      this.database.prepare(`
        UPDATE memory_entries
        SET status = 'active', dedupe_hash = ?, version = ?, supersedes_id = ?,
            last_confirmed_at = ?, payload_ciphertext = ?, payload_nonce = ?, payload_tag = ?, updated_at = ?
        WHERE id = ?
      `).run(
        baseDedupeHash,
        version,
        supersedesId,
        now,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
        row.id,
      )
      this.database.exec('COMMIT')
      return this.get(row.id)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  reject(id: string): MemoryEntry {
    const now = new Date().toISOString()
    const row = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id = ?
    `).get(id) as unknown as MemoryRow | undefined
    if (row === undefined || row.status !== 'candidate') throw new Error(`Unknown memory candidate: ${id}`)
    this.archiveHistory(row, now)
    this.database.prepare("UPDATE memory_entries SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id)
    return this.get(id)
  }

  search(input: { query: string; workspacePath?: string; scope?: 'all' | MemoryScope; limit?: number; minimumScore?: number }): MemoryEntry[] {
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
      .filter(({ entry, score }) => input.minimumScore === undefined
        ? score > 0 || entry.pinned
        : score >= input.minimumScore || entry.pinned)
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

  setPinned(id: string, pinned: boolean): MemoryEntry {
    const result = this.database.prepare(`
      UPDATE memory_entries SET pinned = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'candidate')
    `).run(pinned ? 1 : 0, new Date().toISOString(), id)
    if (result.changes === 0) throw new Error(`Unknown memory: ${id}`)
    return this.get(id)
  }

  delete(id: string): void {
    const now = new Date().toISOString()
    const row = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id = ?
    `).get(id) as unknown as MemoryRow | undefined
    if (row === undefined || row.status !== 'active') throw new Error(`Unknown memory: ${id}`)
    this.archiveHistory(row, now)
    const result = this.database.prepare("UPDATE memory_entries SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(now, id)
    if (result.changes === 0) throw new Error(`Unknown memory: ${id}`)
  }

  getSessionControls(sessionId: string): MemorySessionControls {
    const row = this.database.prepare(`
      SELECT use_memories, generate_memories FROM memory_session_state WHERE session_id = ?
    `).get(sessionId) as { use_memories: number; generate_memories: number } | undefined
    return {
      useMemories: row?.use_memories !== 0,
      generateMemories: row?.generate_memories !== 0,
    }
  }

  setSessionControls(sessionId: string, change: Partial<MemorySessionControls>): MemorySessionControls {
    const current = this.getSessionControls(sessionId)
    const next = { ...current, ...change }
    this.database.prepare(`
      INSERT INTO memory_session_state (session_id, use_memories, generate_memories)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        use_memories = excluded.use_memories,
        generate_memories = excluded.generate_memories
    `).run(sessionId, next.useMemories ? 1 : 0, next.generateMemories ? 1 : 0)
    return next
  }

  getPrincipalThreadExtractionState(): {
    lastProcessedSeq: number
    lastProcessedAt?: string
    lastError?: string
    attempts: number
    nextAttemptAt?: string
  } {
    const row = this.database.prepare(`
      SELECT last_processed_seq, last_processed_at, last_error, attempts, next_attempt_at
      FROM memory_thread_state WHERE id = 1
    `).get() as {
      last_processed_seq: number
      last_processed_at: string | null
      last_error: string | null
      attempts: number
      next_attempt_at: string | null
    }
    return {
      lastProcessedSeq: row.last_processed_seq,
      attempts: row.attempts,
      ...(row.last_processed_at === null ? {} : { lastProcessedAt: row.last_processed_at }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    }
  }

  markPrincipalThreadExtractionSuccess(seq: number): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE memory_thread_state
      SET last_processed_seq = ?, last_processed_at = ?, last_error = NULL,
          attempts = 0, next_attempt_at = NULL
      WHERE id = 1
    `).run(seq, now)
  }

  markPrincipalThreadExtractionFailure(seq: number, error: string, nextAttemptAt: string): void {
    void seq
    this.database.prepare(`
      UPDATE memory_thread_state
      SET last_error = ?, attempts = attempts + 1, next_attempt_at = ?
      WHERE id = 1
    `).run(error.slice(0, 2_000), nextAttemptAt)
  }

  eligibleSessions(
    now: Date,
    idleMinutes: number,
    limit = 5,
  ): MemoryExtractionCandidate[] {
    const cutoff = new Date(now.getTime() - idleMinutes * 60_000).toISOString()
    const rows = this.database.prepare(`
      SELECT s.id, s.working_directory, s.last_seq, s.updated_at
      FROM sessions s
      LEFT JOIN memory_session_state state ON state.session_id = s.id
      WHERE s.last_seq > 0
        AND s.status = 'idle'
        AND s.updated_at <= ?
        AND COALESCE(state.generate_memories, 1) = 1
        AND (state.session_id IS NULL OR state.last_processed_seq < s.last_seq)
        AND (state.next_attempt_at IS NULL OR state.next_attempt_at <= ?)
      ORDER BY s.updated_at ASC
      LIMIT ?
    `).all(cutoff, now.toISOString(), Math.max(1, Math.min(20, limit))) as Array<{
      id: string
      working_directory: string | null
      last_seq: number
      updated_at: string
    }>
    return rows.map((row) => ({
      sessionId: row.id,
      lastSeq: row.last_seq,
      updatedAt: row.updated_at,
      ...(row.working_directory === null ? {} : { workingDirectory: row.working_directory }),
    }))
  }

  markExtractionSuccess(sessionId: string, processedSeq: number): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO memory_session_state (
        session_id, last_processed_seq, last_processed_at, last_error, attempts, next_attempt_at
      ) VALUES (?, ?, ?, NULL, 0, NULL)
      ON CONFLICT(session_id) DO UPDATE SET
        last_processed_seq = MAX(memory_session_state.last_processed_seq, excluded.last_processed_seq),
        last_processed_at = excluded.last_processed_at,
        last_error = NULL,
        attempts = 0,
        next_attempt_at = NULL
    `).run(sessionId, processedSeq, now)
  }

  markExtractionFailure(sessionId: string, processedSeq: number, message: string, retryAt: string): void {
    this.database.prepare(`
      INSERT INTO memory_session_state (
        session_id, last_processed_seq, last_processed_at, last_error, attempts, next_attempt_at
      ) VALUES (?, 0, NULL, ?, 1, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_error = excluded.last_error,
        attempts = memory_session_state.attempts + 1,
        next_attempt_at = excluded.next_attempt_at
    `).run(sessionId, message.slice(0, 1_000), retryAt)
  }

  extractionState(sessionId: string): MemoryExtractionState | undefined {
    const row = this.database.prepare(`
      SELECT session_id, last_processed_seq, last_processed_at, last_error, attempts, next_attempt_at
      FROM memory_session_state WHERE session_id = ?
    `).get(sessionId) as {
      session_id: string
      last_processed_seq: number
      last_processed_at: string | null
      last_error: string | null
      attempts: number
      next_attempt_at: string | null
    } | undefined
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      lastProcessedSeq: row.last_processed_seq,
      attempts: row.attempts,
      ...(row.last_processed_at === null ? {} : { lastProcessedAt: row.last_processed_at }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    }
  }

  activeCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM memory_entries WHERE status = 'active'")
      .get() as { count: number }
    return Number(row.count)
  }

  expireMemories(now = new Date()): number {
    const timestamp = now.toISOString()
    const rows = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memory_entries
      WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until <= ?
    `).all(timestamp) as unknown as MemoryRow[]
    for (const row of rows) {
      this.archiveHistory(row, timestamp)
      this.database.prepare("UPDATE memory_entries SET status = 'expired', updated_at = ? WHERE id = ?")
        .run(timestamp, row.id)
    }
    return rows.length
  }

  private memoryBaseDedupeHash(scope: MemoryScope, workspaceHash: string, kind: MemoryKind, key: string): string {
    return this.cipher.fingerprint([scope, workspaceHash, kind, key.trim().toLowerCase()].join('\0'))
  }

  private memoryCandidateDedupeHash(baseDedupeHash: string, content: string): string {
    return this.cipher.fingerprint(`${baseDedupeHash}\0candidate\0${normalizeForComparison(content)}`)
  }

  private findMemoryByDedupe(
    dedupeHash: string,
    scope: MemoryScope,
    workspaceHash: string,
    kind: MemoryKind,
  ): MemoryRow | undefined {
    return this.database.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memory_entries
      WHERE scope = ? AND workspace_hash = ? AND kind = ? AND dedupe_hash = ?
    `).get(scope, workspaceHash, kind, dedupeHash) as unknown as MemoryRow | undefined
  }

  private decryptPayload(row: MemoryRow): MemoryPayload {
    return memoryPayloadSchema.parse(this.cipher.decrypt<MemoryPayload>({
      ciphertext: row.payload_ciphertext,
      nonce: row.payload_nonce,
      tag: row.payload_tag,
    }, memoryAssociatedData(row.id, row.version)))
  }

  private mergeMemorySources(row: MemoryRow, sourceRefs: string[], sourceSessionId?: string): void {
    const merged = normalizeSourceRefs([...parseSourceRefs(row.source_refs_json), ...sourceRefs])
    const now = new Date().toISOString()
    this.database.prepare('UPDATE memory_entries SET source_refs_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now, row.id)
    if (sourceSessionId !== undefined) {
      this.database.prepare(`
        INSERT OR IGNORE INTO memory_sources (memory_id, session_id, created_at)
        VALUES (?, ?, ?)
      `).run(row.id, sourceSessionId, now)
    }
  }

  private get(id: string): MemoryEntry {
    const row = this.database.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memory_entries WHERE id = ?
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
      key: payload.key,
      scope: row.scope,
      kind: row.kind,
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
      pinned: row.pinned === 1,
      confidence: row.confidence,
      sourceSessionIds: sources.map((source) => source.session_id),
      sourceRefs: parseSourceRefs(row.source_refs_json),
      sourceAuthority: row.source_authority,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      useCount: row.use_count,
    }
    if (row.last_used_at !== null) entry.lastUsedAt = row.last_used_at
    if (row.last_confirmed_at !== null) entry.lastConfirmedAt = row.last_confirmed_at
    if (row.valid_until !== null) entry.validUntil = row.valid_until
    if (row.supersedes_id !== null) entry.supersedesId = row.supersedes_id
    return entry
  }

  private archiveHistory(row: MemoryRow, archivedAt: string): string {
    const revisionId = randomUUID()
    this.database.prepare(`
      INSERT OR IGNORE INTO memory_history (
        id, memory_id, version, source_authority, source_refs_json, valid_until,
        payload_ciphertext, payload_nonce, payload_tag, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      row.id,
      row.version,
      row.source_authority,
      row.source_refs_json,
      row.valid_until,
      row.payload_ciphertext,
      row.payload_nonce,
      row.payload_tag,
      archivedAt,
    )
    return revisionId
  }

  private ensureOptionalColumns(): void {
    const columns = new Set((this.database.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>)
      .map((column) => column.name))
    const additions = [
      ['source_authority', "TEXT NOT NULL DEFAULT 'explicit'"],
      ['source_refs_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['supersedes_id', 'TEXT'],
      ['valid_until', 'TEXT'],
      ['last_confirmed_at', 'TEXT'],
    ] as const
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE memory_entries ADD COLUMN ${name} ${type}`)
    }
  }

  private ensureSettingsColumns(): void {
    const columns = new Set((this.database.prepare('PRAGMA table_info(memory_settings)').all() as Array<{ name: string }>)
      .map((column) => column.name))
    const additions = [
      ['memory_char_limit', 'INTEGER NOT NULL DEFAULT 2200'],
      ['user_char_limit', 'INTEGER NOT NULL DEFAULT 2200'],
    ] as const
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE memory_settings ADD COLUMN ${name} ${type}`)
    }
  }

  private ensureDocumentColumns(): void {
    const columns = new Set((this.database.prepare('PRAGMA table_info(memory_documents)').all() as Array<{ name: string }>)
      .map((column) => column.name))
    if (!columns.has('version')) {
      this.database.exec('ALTER TABLE memory_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
    }
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

function normalizeMemoryTitle(value: string): string {
  const title = value.trim()
  if (title.length === 0 || title.length > 120) throw new Error('Memory title must be between 1 and 120 characters')
  return title
}

function normalizeMemoryContent(value: string): string {
  const content = value.trim()
  if (content.length === 0 || content.length > 2_000) throw new Error('Memory content must be between 1 and 2,000 characters')
  return content
}

function normalizeMemoryTags(values: string[]): string[] {
  const tags = [...new Set(values.map((tag) => tag.trim()).filter(Boolean))]
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) throw new Error('Memory tags exceed their limit')
  return tags
}

function normalizeMemoryConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Memory confidence must be between 0 and 1')
  return value
}

function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function normalizeSettings(input: MemorySettings): MemorySettings {
  const idleMinutes = Math.max(15, Math.min(10_080, Math.floor(input.idleMinutes)))
  const maxEntries = Math.max(10, Math.min(2_000, Math.floor(input.maxEntries)))
  const memoryCharLimit = Math.max(200, Math.min(20_000, Math.floor(input.memoryCharLimit)))
  const userCharLimit = Math.max(200, Math.min(20_000, Math.floor(input.userCharLimit)))
  return { ...input, idleMinutes, maxEntries, memoryCharLimit, userCharLimit }
}

function requireWorkspacePath(path: string | undefined): string {
  if (path === undefined || path.trim().length === 0) throw new Error('Workspace memory requires a working directory')
  return path
}

function memoryAssociatedData(id: string, version: number): string {
  return `memory:${id}:${version}`
}

function documentAssociatedData(name: MemoryDocumentName): string {
  return `memory-document:${name}`
}

function containsSensitiveContent(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))
}

function queryTerms(query: string): string[] {
  const words = query.split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length > 1 || /^[\p{Script=Han}]$/u.test(word))
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

function normalizeSourceRefs(refs: string[]): string[] {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))]
}

function parseSourceRefs(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === 'string') : []
  } catch {
    return []
  }
}

function sourceAuthorityRank(authority: MemorySourceAuthority): number {
  switch (authority) {
    case 'explicit': return 4
    case 'verified': return 3
    case 'observed': return 2
    case 'inferred': return 1
  }
}
