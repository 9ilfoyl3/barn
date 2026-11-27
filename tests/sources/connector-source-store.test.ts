import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'

async function openStore(directory: string, key = randomBytes(32)): Promise<SessionStore> {
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(key))
  await store.initialize()
  return store
}

describe('ConnectorSourceStore', () => {
  it('persists an encrypted connector source and deduplicates events by event key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-connector-source-store-'))
    const path = join(directory, 'sessions.db')
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const source = store.connectorSources.create({
      name: 'Payments issues',
      config: {
        kind: 'github',
        connectorId: 'connector-1',
        owner: 'acme',
        repo: 'private-payments',
        events: ['issues', 'pullRequests'],
        pollSeconds: 60,
      },
    })
    store.connectorSources.saveState(source.id, { initialized: true, cursor: '2026-11-26T00:00:00.000Z' })
    const input = {
      eventKey: 'github_issue:1:2026-11-26T01:00:00.000Z:open',
      matterKey: 'github:acme/private-payments:issue:1',
      kind: 'github_issue' as const,
      title: 'Issue #1: Payment failure',
      summary: 'A private customer report from acme.',
      url: 'https://github.com/acme/private-payments/issues/1',
      occurredAt: '2026-11-26T01:00:00.000Z',
    }
    expect(store.connectorSources.recordEvent(source.id, input).created).toBe(true)
    expect(store.connectorSources.recordEvent(source.id, input).created).toBe(false)
    store.close()

    const raw = new DatabaseSync(path)
    const sourceRow = raw.prepare('SELECT config_ciphertext, state_ciphertext FROM connector_sources WHERE id = ?')
      .get(source.id) as { config_ciphertext: Uint8Array; state_ciphertext: Uint8Array }
    const eventRow = raw.prepare('SELECT summary_ciphertext FROM connector_source_events WHERE source_id = ?')
      .get(source.id) as { summary_ciphertext: Uint8Array }
    expect(Buffer.from(sourceRow.config_ciphertext).toString('utf8')).not.toContain('private-payments')
    expect(Buffer.from(sourceRow.state_ciphertext).toString('utf8')).not.toContain('2026-11-26')
    expect(Buffer.from(eventRow.summary_ciphertext).toString('utf8')).not.toContain('private customer')
    raw.close()

    const reopened = await openStore(directory, key)
    expect(reopened.connectorSources.get(source.id)).toMatchObject({
      name: 'Payments issues',
      enabled: true,
      config: { kind: 'github', owner: 'acme', repo: 'private-payments' },
    })
    expect(reopened.connectorSources.state(source.id)).toMatchObject({ initialized: true })
    expect(reopened.connectorSources.listEvents(source.id)).toMatchObject([{
      title: 'Issue #1: Payment failure',
      matterKey: 'github:acme/private-payments:issue:1',
    }])
    reopened.close()
  })
})
