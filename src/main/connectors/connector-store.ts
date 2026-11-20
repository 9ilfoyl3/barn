import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConnectorConfig } from '../../shared/models'
import type { AesGcmEventCipher } from '../session/event-cipher'
import type { ConnectorRecord } from './types'

interface ConnectorRow {
  id: string
  kind: string
  name: string
  enabled: number
  config_ciphertext: Uint8Array
  config_nonce: Uint8Array
  config_tag: Uint8Array
  last_error_ciphertext: Uint8Array | null
  last_error_nonce: Uint8Array | null
  last_error_tag: Uint8Array | null
  created_at: string
  updated_at: string
}

export interface CreateConnectorRecordInput {
  kind: string
  name: string
  config: ConnectorConfig
}

export interface UpdateConnectorRecordInput {
  name?: string
  config?: ConnectorConfig
  enabled?: boolean
}

/** Encrypted connector configuration. Credentials remain in the OS-backed connector credential store. */
export class ConnectorStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_ciphertext BLOB NOT NULL,
        config_nonce BLOB NOT NULL,
        config_tag BLOB NOT NULL,
        last_error_ciphertext BLOB,
        last_error_nonce BLOB,
        last_error_tag BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connectors_kind_updated
        ON connectors(kind, updated_at DESC);
    `)
  }

  list(): ConnectorRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM connectors ORDER BY created_at ASC, id ASC
    `).all() as unknown as ConnectorRow[]
    return rows.map((row) => this.toRecord(row))
  }

  get(id: string): ConnectorRecord {
    const row = this.database.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow | undefined
    if (row === undefined) throw new Error(`Unknown connector: ${id}`)
    return this.toRecord(row)
  }

  create(input: CreateConnectorRecordInput, connectorId: string = randomUUID()): ConnectorRecord {
    const now = new Date().toISOString()
    const config = this.cipher.encrypt(input.config, configAssociatedData(connectorId))
    this.database.prepare(`
      INSERT INTO connectors (
        id, kind, name, enabled,
        config_ciphertext, config_nonce, config_tag,
        last_error_ciphertext, last_error_nonce, last_error_tag,
        created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      connectorId,
      requireText(input.kind, 'Connector kind', 80),
      requireText(input.name, 'Connector name', 200),
      config.ciphertext,
      config.nonce,
      config.tag,
      now,
      now,
    )
    return this.get(connectorId)
  }

  update(id: string, input: UpdateConnectorRecordInput): ConnectorRecord {
    const current = this.get(id)
    const name = input.name === undefined ? current.name : requireText(input.name, 'Connector name', 200)
    const enabled = input.enabled ?? current.enabled
    const configValue = input.config ?? current.config
    const encryptedConfig = this.cipher.encrypt(configValue, configAssociatedData(id))
    const encryptedError = current.lastError === undefined
      ? undefined
      : this.cipher.encrypt(current.lastError, errorAssociatedData(id))
    this.database.prepare(`
      UPDATE connectors SET
        name = ?, enabled = ?,
        config_ciphertext = ?, config_nonce = ?, config_tag = ?,
        last_error_ciphertext = ?, last_error_nonce = ?, last_error_tag = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      name,
      enabled ? 1 : 0,
      encryptedConfig.ciphertext,
      encryptedConfig.nonce,
      encryptedConfig.tag,
      encryptedError?.ciphertext ?? null,
      encryptedError?.nonce ?? null,
      encryptedError?.tag ?? null,
      new Date().toISOString(),
      id,
    )
    return this.get(id)
  }

  setError(id: string, error: string | undefined): ConnectorRecord {
    this.get(id)
    const encrypted = error === undefined ? undefined : this.cipher.encrypt(error.slice(0, 2_000), errorAssociatedData(id))
    this.database.prepare(`
      UPDATE connectors SET
        last_error_ciphertext = ?, last_error_nonce = ?, last_error_tag = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      encrypted?.ciphertext ?? null,
      encrypted?.nonce ?? null,
      encrypted?.tag ?? null,
      new Date().toISOString(),
      id,
    )
    return this.get(id)
  }

  remove(id: string): void {
    const result = this.database.prepare('DELETE FROM connectors WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw new Error(`Unknown connector: ${id}`)
  }

  private toRecord(row: ConnectorRow): ConnectorRecord {
    const record: ConnectorRecord = {
      id: row.id,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled === 1,
      config: this.cipher.decrypt<ConnectorConfig>({
        ciphertext: row.config_ciphertext,
        nonce: row.config_nonce,
        tag: row.config_tag,
      }, configAssociatedData(row.id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.last_error_ciphertext !== null && row.last_error_nonce !== null && row.last_error_tag !== null) {
      record.lastError = this.cipher.decrypt<string>({
        ciphertext: row.last_error_ciphertext,
        nonce: row.last_error_nonce,
        tag: row.last_error_tag,
      }, errorAssociatedData(row.id))
    }
    return record
  }
}

function configAssociatedData(id: string): string {
  return `connector:${id}:config`
}

function errorAssociatedData(id: string): string {
  return `connector:${id}:error`
}

function requireText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${label} is required`)
  if (normalized.length > maxLength) throw new Error(`${label} is too long`)
  return normalized
}
