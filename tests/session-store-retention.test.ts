import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../src/main/session/event-cipher'
import { SessionStore } from '../src/main/session/session-store'

describe('session store retention', () => {
  it('prunes old terminal action audit events without deleting the action record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-retention-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    store.setRetentionDays(30)
    const action = store.actions.create({
      kind: 'test.action',
      idempotencyKey: 'retention-action',
      permissionKind: 'workspace-write',
      title: 'Old action',
      summary: 'An old action.',
      payload: { value: 1 },
    }, 'queued')
    const claimed = store.actions.claim(action.id, '2025-01-01T00:00:00.000Z')!
    store.actions.succeed(claimed.id, { ok: true }, '2025-01-01T00:00:01.000Z')

    const result = store.runRetention(new Date('2026-11-14T00:00:00.000Z'))
    expect(result.actionEvents).toBeGreaterThan(0)
    expect(store.actions.events(action.id)).toEqual([])
    expect(store.actions.get(action.id).status).toBe('succeeded')
    store.close()
  })
})
