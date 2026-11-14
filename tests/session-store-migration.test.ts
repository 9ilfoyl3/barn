import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../src/main/session/event-cipher'
import { CURRENT_SCHEMA_VERSION, SessionStore } from '../src/main/session/session-store'

describe('database schema migration', () => {
  it('adds schema metadata and retention defaults to a legacy database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-schema-migration-'))
    const path = join(directory, 'sessions.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE session_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
        payload_ciphertext BLOB NOT NULL, payload_nonce BLOB NOT NULL, payload_tag BLOB NOT NULL,
        actor_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `)
    raw.close()

    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(store.getRetentionDays()).toBe(365)
    store.close()
  })

  it('refuses a database created by a newer schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-schema-newer-'))
    const path = join(directory, 'sessions.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO schema_meta VALUES (1, ${CURRENT_SCHEMA_VERSION + 1}, '2026-11-14T00:00:00.000Z');
    `)
    raw.close()
    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await expect(store.initialize()).rejects.toThrow('newer than this app supports')
    store.close()
  })
})
