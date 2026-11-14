import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AesGcmEventCipher } from '../session/event-cipher'
import type { AutomationSettings, CreateLocalSourceInput, LocalSource, LocalSourceConfig } from '../../shared/models'

interface SourceRow {
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
  created_at: string
  updated_at: string
}

export interface LocalSourceState {
  initialized?: boolean
  files?: Record<string, string>
  nextRunAt?: string
  lastSuggestionAt?: string
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  mode: 'observe',
  maxPendingSuggestions: 20,
  suggestionCooldownMinutes: 15,
}

export interface LocalSourceEventInput {
  eventKey: string
  title: string
  prompt: string
}

export interface LocalSourceEvent {
  id: string
  sourceId: string
  eventKey: string
  taskId?: string
  createdAt: string
}

export class LocalSourceStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_sources (
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_source_events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES local_sources(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        prompt_ciphertext BLOB NOT NULL,
        prompt_nonce BLOB NOT NULL,
        prompt_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source_id, event_key)
      );

      CREATE INDEX IF NOT EXISTS local_source_events_source
        ON local_source_events(source_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS automation_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL,
        max_pending_suggestions INTEGER NOT NULL,
        suggestion_cooldown_minutes INTEGER NOT NULL
      );
    `)
    this.database.prepare(`
      INSERT OR IGNORE INTO automation_settings (
        id, mode, max_pending_suggestions, suggestion_cooldown_minutes
      ) VALUES (1, ?, ?, ?)
    `).run(
      DEFAULT_AUTOMATION_SETTINGS.mode,
      DEFAULT_AUTOMATION_SETTINGS.maxPendingSuggestions,
      DEFAULT_AUTOMATION_SETTINGS.suggestionCooldownMinutes,
    )
  }

  getAutomationSettings(): AutomationSettings {
    const row = this.database.prepare(`
      SELECT mode, max_pending_suggestions, suggestion_cooldown_minutes
      FROM automation_settings WHERE id = 1
    `).get() as {
      mode: string
      max_pending_suggestions: number
      suggestion_cooldown_minutes: number
    } | undefined
    if (row === undefined) return { ...DEFAULT_AUTOMATION_SETTINGS }
    if (row.mode !== 'observe' && row.mode !== 'active') throw new Error(`Unknown automation mode: ${row.mode}`)
    return {
      mode: row.mode,
      maxPendingSuggestions: row.max_pending_suggestions,
      suggestionCooldownMinutes: row.suggestion_cooldown_minutes,
    }
  }

  setAutomationSettings(settings: AutomationSettings): AutomationSettings {
    if (settings.mode !== 'observe' && settings.mode !== 'active') {
      throw new Error(`Unknown automation mode: ${settings.mode}`)
    }
    if (!Number.isInteger(settings.maxPendingSuggestions) || settings.maxPendingSuggestions < 1 || settings.maxPendingSuggestions > 200) {
      throw new Error('Pending suggestion limit must be between 1 and 200')
    }
    if (!Number.isInteger(settings.suggestionCooldownMinutes) || settings.suggestionCooldownMinutes < 0 || settings.suggestionCooldownMinutes > 10_080) {
      throw new Error('Suggestion cooldown must be between 0 and 10,080 minutes')
    }
    this.database.prepare(`
      UPDATE automation_settings
      SET mode = ?, max_pending_suggestions = ?, suggestion_cooldown_minutes = ?
      WHERE id = 1
    `).run(settings.mode, settings.maxPendingSuggestions, settings.suggestionCooldownMinutes)
    return this.getAutomationSettings()
  }

  list(): LocalSource[] {
    const rows = this.database.prepare('SELECT * FROM local_sources ORDER BY created_at ASC, id ASC').all() as unknown as SourceRow[]
    return rows.map((row) => this.toSource(row))
  }

  get(sourceId: string): LocalSource {
    const row = this.database.prepare('SELECT * FROM local_sources WHERE id = ?').get(sourceId) as SourceRow | undefined
    if (row === undefined) throw new Error(`Unknown local source: ${sourceId}`)
    return this.toSource(row)
  }

  create(input: CreateLocalSourceInput, sourceId: string = randomUUID()): LocalSource {
    const name = requireText(input.name, 'Source name', 120)
    const config = validateConfig(input.config)
    const now = new Date().toISOString()
    const state: LocalSourceState = config.kind === 'file-watch'
      ? { initialized: false, files: {} }
      : { nextRunAt: new Date(Date.now() + config.intervalMinutes * 60_000).toISOString() }
    const encryptedConfig = this.cipher.encrypt(config, sourceAssociatedData(sourceId, 'config'))
    const encryptedState = this.cipher.encrypt(state, sourceAssociatedData(sourceId, 'state'))
    this.database.prepare(`
      INSERT INTO local_sources (
        id, name, enabled,
        config_ciphertext, config_nonce, config_tag,
        state_ciphertext, state_nonce, state_tag,
        last_error_ciphertext, last_error_nonce, last_error_tag,
        created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
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

  setEnabled(sourceId: string, enabled: boolean): LocalSource {
    const now = new Date().toISOString()
    const result = this.database.prepare('UPDATE local_sources SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, sourceId)
    if (Number(result.changes) === 0) throw new Error(`Unknown local source: ${sourceId}`)
    return this.get(sourceId)
  }

  remove(sourceId: string): void {
    this.database.prepare('DELETE FROM local_sources WHERE id = ?').run(sourceId)
  }

  state(sourceId: string): LocalSourceState {
    const row = this.database.prepare(`
      SELECT state_ciphertext, state_nonce, state_tag FROM local_sources WHERE id = ?
    `).get(sourceId) as { state_ciphertext: Uint8Array; state_nonce: Uint8Array; state_tag: Uint8Array } | undefined
    if (row === undefined) throw new Error(`Unknown local source: ${sourceId}`)
    return this.cipher.decrypt({
      ciphertext: row.state_ciphertext,
      nonce: row.state_nonce,
      tag: row.state_tag,
    }, sourceAssociatedData(sourceId, 'state')) as LocalSourceState
  }

  saveState(sourceId: string, state: LocalSourceState): void {
    const encrypted = this.cipher.encrypt(state, sourceAssociatedData(sourceId, 'state'))
    this.database.prepare(`
      UPDATE local_sources
      SET state_ciphertext = ?, state_nonce = ?, state_tag = ?, updated_at = ?
      WHERE id = ?
    `).run(encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), sourceId)
  }

  saveError(sourceId: string, error: string | undefined): void {
    const encrypted = error === undefined ? undefined : this.cipher.encrypt(error, sourceAssociatedData(sourceId, 'error'))
    this.database.prepare(`
      UPDATE local_sources
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

  recordEvent(sourceId: string, input: LocalSourceEventInput, eventId: string = randomUUID()): { event: LocalSourceEvent; created: boolean } {
    const existing = this.database.prepare(`
      SELECT id, source_id, event_key, task_id, created_at FROM local_source_events
      WHERE source_id = ? AND event_key = ?
    `).get(sourceId, input.eventKey) as {
      id: string
      source_id: string
      event_key: string
      task_id: string | null
      created_at: string
    } | undefined
    if (existing !== undefined) return { event: toEvent(existing), created: false }
    const encryptedPrompt = this.cipher.encrypt(input.prompt, eventAssociatedData(eventId, 'prompt'))
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO local_source_events (
        id, source_id, event_key, task_id, title,
        prompt_ciphertext, prompt_nonce, prompt_tag, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(eventId, sourceId, input.eventKey, input.title, encryptedPrompt.ciphertext, encryptedPrompt.nonce, encryptedPrompt.tag, now)
    return {
      event: { id: eventId, sourceId, eventKey: input.eventKey, createdAt: now },
      created: true,
    }
  }

  attachTask(eventId: string, taskId: string): void {
    this.database.prepare('UPDATE local_source_events SET task_id = ? WHERE id = ?').run(taskId, eventId)
  }

  private toSource(row: SourceRow): LocalSource {
    const source: LocalSource = {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      config: this.cipher.decrypt({
        ciphertext: row.config_ciphertext,
        nonce: row.config_nonce,
        tag: row.config_tag,
      }, sourceAssociatedData(row.id, 'config')) as LocalSourceConfig,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.last_error_ciphertext !== null && row.last_error_nonce !== null && row.last_error_tag !== null) {
      source.lastError = this.cipher.decrypt({
        ciphertext: row.last_error_ciphertext,
        nonce: row.last_error_nonce,
        tag: row.last_error_tag,
      }, sourceAssociatedData(row.id, 'error')) as string
    }
    return source
  }
}

function validateConfig(config: LocalSourceConfig): LocalSourceConfig {
  if (config.kind === 'file-watch') {
    const path = requireText(config.path, 'Watch path', 4_000)
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) throw new Error('Watch path must be absolute')
    const maxDepth = config.maxDepth
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error('Watch depth must be between 0 and 8')
    return { kind: 'file-watch', path, recursive: config.recursive, maxDepth }
  }
  const intervalMinutes = config.intervalMinutes
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10_080) {
    throw new Error('Schedule interval must be between 1 and 10,080 minutes')
  }
  return {
    kind: 'schedule',
    intervalMinutes,
    title: requireText(config.title, 'Schedule title', 200),
    prompt: requireText(config.prompt, 'Schedule prompt', 20_000),
  }
}

function toEvent(row: {
  id: string
  source_id: string
  event_key: string
  task_id: string | null
  created_at: string
}): LocalSourceEvent {
  const event: LocalSourceEvent = {
    id: row.id,
    sourceId: row.source_id,
    eventKey: row.event_key,
    createdAt: row.created_at,
  }
  if (row.task_id !== null) event.taskId = row.task_id
  return event
}

function sourceAssociatedData(sourceId: string, field: 'config' | 'state' | 'error'): string {
  return `local-source:${sourceId}:${field}`
}

function eventAssociatedData(eventId: string, field: 'prompt'): string {
  return `local-source-event:${eventId}:${field}`
}

function requireText(value: string, label: string, max: number): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`${label} cannot be empty`)
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`)
  return text
}
