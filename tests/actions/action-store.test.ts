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

const input = {
  kind: 'test.action',
  idempotencyKey: 'request-1',
  permissionKind: 'workspace-write' as const,
  title: 'Test action',
  summary: 'Perform a test action.',
  payload: { path: 'output/report.txt', secret: 'payload-secret' },
}

describe('ActionStore', () => {
  it('deduplicates actions by idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-action-store-'))
    const store = await openStore(directory)
    const first = store.actions.create(input, 'queued')
    const second = store.actions.create({ ...input, title: 'Ignored duplicate' }, 'queued')
    expect(second.id).toBe(first.id)
    expect(second.title).toBe('Test action')
    store.close()
  })

  it('encrypts payloads, errors, results, and event data at rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-action-store-'))
    const path = join(directory, 'sessions.db')
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const action = store.actions.create(input, 'queued')
    const claimed = store.actions.claim(action.id)!
    store.actions.fail(claimed.id, 'retry secret', new Date(Date.now() + 1_000).toISOString())

    const beforeSuccess = new DatabaseSync(path)
    const pendingRow = beforeSuccess.prepare(`
      SELECT payload_ciphertext, last_error_ciphertext FROM actions WHERE id = ?
    `).get(action.id) as {
      payload_ciphertext: Uint8Array
      last_error_ciphertext: Uint8Array
    }
    const event = beforeSuccess.prepare('SELECT data_ciphertext FROM action_events ORDER BY id LIMIT 1')
      .get() as { data_ciphertext: Uint8Array }
    expect(Buffer.from(pendingRow.payload_ciphertext).toString('utf8')).not.toContain('payload-secret')
    expect(Buffer.from(pendingRow.last_error_ciphertext).toString('utf8')).not.toContain('retry secret')
    expect(Buffer.from(event.data_ciphertext).toString('utf8')).not.toContain('queued')
    beforeSuccess.close()

    const queued = store.actions.get(action.id)
    const claimedAgain = store.actions.claim(queued.id)!
    const succeeded = store.actions.succeed(claimedAgain.id, { externalId: 'result-secret' })
    const eventTypes = store.actions.events(action.id).map((entry) => entry.type)
    store.close()

    const afterSuccess = new DatabaseSync(path)
    const resultRow = afterSuccess.prepare('SELECT result_ciphertext FROM actions WHERE id = ?')
      .get(action.id) as { result_ciphertext: Uint8Array }
    expect(Buffer.from(resultRow.result_ciphertext).toString('utf8')).not.toContain('result-secret')
    afterSuccess.close()

    expect(succeeded).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      result: { externalId: 'result-secret' },
    })
    expect(eventTypes).toEqual([
      'created',
      'started',
      'retry_scheduled',
      'started',
      'succeeded',
    ])
  })

  it('recoveres running actions and preserves retry audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-action-store-'))
    const store = await openStore(directory)
    const action = store.actions.create(input, 'queued')
    store.actions.claim(action.id)
    expect(store.actions.recoverRunning()).toBe(1)
    expect(store.actions.get(action.id).status).toBe('queued')
    expect(store.actions.events(action.id).map((event) => event.type)).toEqual(['created', 'started', 'recovered'])
    store.close()
  })

  it('retries only failed actions and stops after max attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-action-store-'))
    const store = await openStore(directory)
    const action = store.actions.create({ ...input, maxAttempts: 1 }, 'queued')
    const claimed = store.actions.claim(action.id)!
    const failed = store.actions.fail(claimed.id, 'permanent failure', undefined)
    expect(failed.status).toBe('failed')
    expect(failed.lastError).toBe('permanent failure')
    expect(store.actions.retry(action.id).status).toBe('queued')
    store.close()
  })
})
