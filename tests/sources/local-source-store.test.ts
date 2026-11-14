import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'

async function openStore(directory: string, key = randomBytes(32)): Promise<SessionStore> {
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(key))
  await store.initialize()
  return store
}

describe('LocalSourceStore', () => {
  it('persists encrypted source configuration and state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-source-store-'))
    const path = join(directory, 'sessions.db')
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const source = store.localSources.create({
      name: 'Downloads',
      config: { kind: 'file-watch', path: resolve('/tmp/downloads-private'), recursive: true, maxDepth: 3 },
    })
    store.localSources.saveState(source.id, { initialized: true, files: { '/tmp/downloads-private/secret.txt': '1:2' } })
    store.close()

    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT config_ciphertext, state_ciphertext FROM local_sources WHERE id = ?')
      .get(source.id) as { config_ciphertext: Uint8Array; state_ciphertext: Uint8Array }
    expect(Buffer.from(row.config_ciphertext).toString('utf8')).not.toContain('downloads-private')
    expect(Buffer.from(row.state_ciphertext).toString('utf8')).not.toContain('secret.txt')
    raw.close()

    const reopened = await openStore(directory, key)
    expect(reopened.localSources.get(source.id)).toMatchObject({
      name: 'Downloads',
      enabled: true,
      config: { kind: 'file-watch', recursive: true, maxDepth: 3 },
    })
    expect(reopened.localSources.state(source.id)).toMatchObject({ initialized: true })
    reopened.close()
  })

  it('deduplicates source events and supports enable, disable, and removal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-source-store-'))
    const store = await openStore(directory)
    const source = store.localSources.create({
      name: 'Morning review',
      config: { kind: 'schedule', intervalMinutes: 60, title: 'Review priorities', prompt: 'Review today.' },
    })
    const event = { eventKey: 'schedule:one', title: 'Review priorities', prompt: 'Review today.' }
    expect(store.localSources.recordEvent(source.id, event).created).toBe(true)
    expect(store.localSources.recordEvent(source.id, event).created).toBe(false)
    expect(store.localSources.setEnabled(source.id, false).enabled).toBe(false)
    store.localSources.remove(source.id)
    expect(store.localSources.list()).toEqual([])
    store.close()
  })
})
