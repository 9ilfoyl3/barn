import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AesGcmEventCipher } from '../session/event-cipher'
import type {
  ConnectorSource,
  ConnectorSourceConfig,
  ConnectorSourceEvent,
  ConnectorSourceEventKind,
  CreateConnectorSourceInput,
} from '../../shared/models'

interface ConnectorSourceRow {
  id: string
  name: string
  enabled: number
  config_ciphertext: Uint8Array
  config_nonce: Uint8Array
  config_tag: Uint8Array
  state_ciphertext: Uint8Array
  state_nonce: Uint8Array
  state_tag: Uint8Array
  last_error_ciphertext: Uint8Array | null
  last_error_nonce: Uint8Array | null
  last_error_tag: Uint8Array | null
  last_checked_at: string | null
  last_event_at: string | null
  created_at: string
  updated_at: string
}

interface ConnectorSourceEventRow {
  id: string
  source_id: string
  event_key: string
  matter_key: string
  kind: string
  title: string
  summary_ciphertext: Uint8Array
  summary_nonce: Uint8Array
  summary_tag: Uint8Array
  url: string | null
  task_id: string | null
  occurred_at: string
  created_at: string
}

export interface ConnectorSourceState {
  initialized?: boolean
  cursor?: string
  lastSuggestionAt?: string
}

export interface ConnectorSourceEventInput {
  eventKey: string
  matterKey: string
  kind: ConnectorSourceEventKind
  title: string
  summary: string
  url?: string
  occurredAt: string
}

const EVENT_KINDS: readonly ConnectorSourceEventKind[] = [
  'github_issue',
  'github_pull_request',
  'dingtalk_message',
  'dingtalk_todo',
]

/** Durable connector-backed event sources, separate from the connector credential/capability record. */
export class ConnectorSourceStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS connector_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_ciphertext BLOB NOT NULL,
        config_nonce BLOB NOT NULL,
        config_tag BLOB NOT NULL,
        state_ciphertext BLOB NOT NULL,
        state_nonce BLOB NOT NULL,
        state_tag BLOB NOT NULL,
        last_error_ciphertext BLOB,
        last_error_nonce BLOB,
        last_error_tag BLOB,
        last_checked_at TEXT,
        last_event_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_source_events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES connector_sources(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        matter_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary_ciphertext BLOB NOT NULL,
        summary_nonce BLOB NOT NULL,
        summary_tag BLOB NOT NULL,
        url TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source_id, event_key)
      );

      CREATE INDEX IF NOT EXISTS connector_sources_enabled
        ON connector_sources(enabled, updated_at DESC);
      CREATE INDEX IF NOT EXISTS connector_source_events_source
        ON connector_source_events(source_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS connector_source_events_matter
        ON connector_source_events(matter_key, created_at DESC);
    `)
  }

  list(): ConnectorSource[] {
    const rows = this.database.prepare(`
      SELECT * FROM connector_sources ORDER BY created_at ASC, id ASC
    `).all() as unknown as ConnectorSourceRow[]
    return rows.map((row) => this.toSource(row))
  }

  get(sourceId: string): ConnectorSource {
    const row = this.database.prepare('SELECT * FROM connector_sources WHERE id = ?').get(sourceId) as ConnectorSourceRow | undefined
    if (row === undefined) throw new Error(`Unknown connector source: ${sourceId}`)
    return this.toSource(row)
  }

  create(input: CreateConnectorSourceInput, sourceId: string = randomUUID()): ConnectorSource {
    const name = requireText(input.name, 'Source name', 120)
    const config = validateConfig(input.config)
    const encryptedConfig = this.cipher.encrypt(config, associatedData(sourceId, 'config'))
    const encryptedState = this.cipher.encrypt({}, associatedData(sourceId, 'state'))
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO connector_sources (
        id, name, enabled,
        config_ciphertext, config_nonce, config_tag,
        state_ciphertext, state_nonce, state_tag,
        last_error_ciphertext, last_error_nonce, last_error_tag,
        last_checked_at, last_event_at, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      sourceId,
      name,
      encryptedConfig.ciphertext,
      encryptedConfig.nonce,
      encryptedConfig.tag,
      encryptedState.ciphertext,
      encryptedState.nonce,
      encryptedState.tag,
      now,
      now,
    )
    return this.get(sourceId)
  }

  setEnabled(sourceId: string, enabled: boolean): ConnectorSource {
    const result = this.database.prepare(`
      UPDATE connector_sources SET enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, new Date().toISOString(), sourceId)
    if (result.changes === 0) throw new Error(`Unknown connector source: ${sourceId}`)
    return this.get(sourceId)
  }

  remove(sourceId: string): void {
    const result = this.database.prepare('DELETE FROM connector_sources WHERE id = ?').run(sourceId)
    if (result.changes === 0) throw new Error(`Unknown connector source: ${sourceId}`)
  }

  state(sourceId: string): ConnectorSourceState {
    const row = this.database.prepare(`
      SELECT state_ciphertext, state_nonce, state_tag FROM connector_sources WHERE id = ?
    `).get(sourceId) as Pick<ConnectorSourceRow, 'state_ciphertext' | 'state_nonce' | 'state_tag'> | undefined
    if (row === undefined) throw new Error(`Unknown connector source: ${sourceId}`)
    return this.cipher.decrypt({
      ciphertext: row.state_ciphertext,
      nonce: row.state_nonce,
      tag: row.state_tag,
    }, associatedData(sourceId, 'state')) as ConnectorSourceState
  }

  saveState(sourceId: string, state: ConnectorSourceState): void {
    const encrypted = this.cipher.encrypt(state, associatedData(sourceId, 'state'))
    this.database.prepare(`
      UPDATE connector_sources
      SET state_ciphertext = ?, state_nonce = ?, state_tag = ?, updated_at = ?
      WHERE id = ?
    `).run(encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), sourceId)
  }

  saveError(sourceId: string, error: string | undefined): void {
    const encrypted = error === undefined ? undefined : this.cipher.encrypt(error.slice(0, 2_000), associatedData(sourceId, 'error'))
    this.database.prepare(`
      UPDATE connector_sources
      SET last_error_ciphertext = ?, last_error_nonce = ?, last_error_tag = ?, updated_at = ?
      WHERE id = ?
    `).run(
      encrypted?.ciphertext ?? null,
      encrypted?.nonce ?? null,
      encrypted?.tag ?? null,
      new Date().toISOString(),
      sourceId,
    )
  }

  markChecked(sourceId: string, eventAt?: string): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE connector_sources
      SET last_checked_at = ?,
          last_event_at = COALESCE(?, last_event_at),
          updated_at = ?
      WHERE id = ?
    `).run(now, eventAt ?? null, now, sourceId)
  }

  recordEvent(sourceId: string, input: ConnectorSourceEventInput, eventId: string = randomUUID()): { event: ConnectorSourceEvent; created: boolean } {
    if (!EVENT_KINDS.includes(input.kind)) throw new Error(`Unknown connector source event kind: ${input.kind}`)
    const existing = this.database.prepare(`
      SELECT * FROM connector_source_events WHERE source_id = ? AND event_key = ?
    `).get(sourceId, input.eventKey) as ConnectorSourceEventRow | undefined
    if (existing !== undefined) return { event: this.toEvent(existing), created: false }

    const summary = requireText(input.summary, 'Event summary', 20_000)
    const encrypted = this.cipher.encrypt(summary, eventAssociatedData(eventId, 'summary'))
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO connector_source_events (
        id, source_id, event_key, matter_key, kind, title,
        summary_ciphertext, summary_nonce, summary_tag,
        url, task_id, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      eventId,
      sourceId,
      requireText(input.eventKey, 'Event key', 1_000),
      requireText(input.matterKey, 'Matter key', 1_000),
      input.kind,
      requireText(input.title, 'Event title', 300),
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      input.url === undefined ? null : requireText(input.url, 'Event URL', 4_000),
      normalizeTime(input.occurredAt),
      now,
    )
    return { event: this.getEvent(eventId), created: true }
  }

  getEvent(eventId: string): ConnectorSourceEvent {
    const row = this.database.prepare('SELECT * FROM connector_source_events WHERE id = ?').get(eventId) as ConnectorSourceEventRow | undefined
    if (row === undefined) throw new Error(`Unknown connector source event: ${eventId}`)
    return this.toEvent(row)
  }

  listEvents(sourceId?: string, limit = 50): ConnectorSourceEvent[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)))
    const rows = sourceId === undefined
      ? this.database.prepare(`
          SELECT * FROM connector_source_events ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(bounded) as unknown as ConnectorSourceEventRow[]
      : this.database.prepare(`
          SELECT * FROM connector_source_events WHERE source_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(sourceId, bounded) as unknown as ConnectorSourceEventRow[]
    return rows.map((row) => this.toEvent(row))
  }

  attachTask(eventId: string, taskId: string): void {
    const result = this.database.prepare('UPDATE connector_source_events SET task_id = ? WHERE id = ?').run(taskId, eventId)
    if (result.changes === 0) throw new Error(`Unknown connector source event: ${eventId}`)
  }

  /** Active task already representing this matter, so a changed item continues it instead of creating another. */
  openTaskForMatter(matterKey: string): string | undefined {
    const row = this.database.prepare(`
      SELECT e.task_id
      FROM connector_source_events e
      JOIN tasks t ON t.id = e.task_id
      WHERE e.matter_key = ?
        AND t.status IN ('proposed', 'queued', 'running', 'waiting')
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    `).get(matterKey) as { task_id: string } | undefined
    return row?.task_id
  }

  private toSource(row: ConnectorSourceRow): ConnectorSource {
    const source: ConnectorSource = {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      config: this.cipher.decrypt({
        ciphertext: row.config_ciphertext,
        nonce: row.config_nonce,
        tag: row.config_tag,
      }, associatedData(row.id, 'config')) as ConnectorSourceConfig,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.last_error_ciphertext !== null && row.last_error_nonce !== null && row.last_error_tag !== null) {
      source.lastError = this.cipher.decrypt({
        ciphertext: row.last_error_ciphertext,
        nonce: row.last_error_nonce,
        tag: row.last_error_tag,
      }, associatedData(row.id, 'error')) as string
    }
    if (row.last_checked_at !== null) source.lastCheckedAt = row.last_checked_at
    if (row.last_event_at !== null) source.lastEventAt = row.last_event_at
    return source
  }

  private toEvent(row: ConnectorSourceEventRow): ConnectorSourceEvent {
    const event: ConnectorSourceEvent = {
      id: row.id,
      sourceId: row.source_id,
      kind: row.kind as ConnectorSourceEventKind,
      title: row.title,
      summary: this.cipher.decrypt({
        ciphertext: row.summary_ciphertext,
        nonce: row.summary_nonce,
        tag: row.summary_tag,
      }, eventAssociatedData(row.id, 'summary')) as string,
      matterKey: row.matter_key,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    }
    if (row.url !== null) event.url = row.url
    if (row.task_id !== null) event.taskId = row.task_id
    return event
  }
}

function validateConfig(config: ConnectorSourceConfig): ConnectorSourceConfig {
  if (config.kind === 'github') {
    const owner = requirePattern(config.owner, 'Repository owner', 200)
    const repo = requirePattern(config.repo, 'Repository name', 200)
    if (config.events.length === 0) throw new Error('Select at least one GitHub event type')
    const events = [...new Set(config.events)]
    if (events.some((event) => event !== 'issues' && event !== 'pullRequests')) {
      throw new Error('Unknown GitHub event type')
    }
    return {
      kind: 'github',
      connectorId: requireText(config.connectorId, 'Connector', 200),
      owner,
      repo,
      events,
      pollSeconds: pollSeconds(config.pollSeconds),
    }
  }

  const conversationId = optionalText(config.conversationId, 'DingTalk conversation', 500)
  const userId = optionalText(config.userId, 'DingTalk user', 500)
  if ((conversationId === undefined) === (userId === undefined)) {
    throw new Error('Choose exactly one DingTalk conversation or user')
  }
  if (config.events.length === 0) throw new Error('Select at least one DingTalk event type')
  const events = [...new Set(config.events)]
  if (events.some((event) => event !== 'messages' && event !== 'todos')) {
    throw new Error('Unknown DingTalk event type')
  }
  return {
    kind: 'dingtalk',
    connectorId: requireText(config.connectorId, 'Connector', 200),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(userId === undefined ? {} : { userId }),
    keywords: config.keywords.map((keyword) => requireText(keyword, 'Keyword', 100)).slice(0, 20),
    events,
    pollSeconds: pollSeconds(config.pollSeconds),
  }
}

function pollSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 30 || value > 3_600) {
    throw new Error('Poll interval must be between 30 and 3,600 seconds')
  }
  return value
}

function requirePattern(value: string, label: string, max: number): string {
  const normalized = requireText(value, label, max)
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error(`${label} contains unsupported characters`)
  return normalized
}

function optionalText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return requireText(value, label, max)
}

function requireText(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${label} cannot be empty`)
  if (normalized.length > max) throw new Error(`${label} must be ${max} characters or fewer`)
  return normalized
}

function normalizeTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString()
}

function associatedData(sourceId: string, field: 'config' | 'state' | 'error'): string {
  return `connector-source:${sourceId}:${field}`
}

function eventAssociatedData(eventId: string, field: 'summary'): string {
  return `connector-source-event:${eventId}:${field}`
}
