import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { DEFAULT_PERMISSION_POLICY } from '../../src/main/permissions/permission-store'

async function openStore(directory: string): Promise<SessionStore> {
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await store.initialize()
  return store
}

describe('PermissionStore', () => {
  it('persists safety policy changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-permission-store-'))
    const store = await openStore(directory)
    expect(store.permissions.getPolicy()).toEqual(DEFAULT_PERMISSION_POLICY)

    store.permissions.setPolicy({
      localRead: 'allow',
      workspaceWrite: 'ask',
      externalWrite: 'deny',
      destructive: 'ask',
    })
    store.close()

    const reopened = await openStore(directory)
    expect(reopened.permissions.getPolicy()).toEqual({
      localRead: 'allow',
      workspaceWrite: 'ask',
      externalWrite: 'deny',
      destructive: 'ask',
    })
    reopened.close()
  })

  it('encrypts approval summaries and details at rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-permission-store-'))
    const path = join(directory, 'sessions.db')
    const key = randomBytes(32)
    const store = new SessionStore(path, new AesGcmEventCipher(key))
    await store.initialize()
    const approval = store.permissions.createApproval({
      kind: 'external-write',
      title: 'Send the report',
      summary: 'Send the confidential report.',
      details: 'Recipient: private@example.com',
    })
    store.close()

    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT summary_ciphertext, details_ciphertext FROM approvals WHERE id = ?').get(approval.id) as {
      summary_ciphertext: Uint8Array
      details_ciphertext: Uint8Array
    }
    expect(Buffer.from(row.summary_ciphertext).toString('utf8')).not.toContain('confidential')
    expect(Buffer.from(row.details_ciphertext).toString('utf8')).not.toContain('private@example.com')
    raw.close()

    const reopened = new SessionStore(path, new AesGcmEventCipher(key))
    await reopened.initialize()
    expect(reopened.permissions.get(approval.id)).toMatchObject({
      summary: 'Send the confidential report.',
      details: 'Recipient: private@example.com',
    })
    reopened.close()
  })

  it('creates, lists, and resolves durable approvals once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-permission-store-'))
    const store = await openStore(directory)
    const approval = store.permissions.createApproval({
      kind: 'external-write',
      title: 'Send the report',
      summary: 'Send the finished report to the client.',
      details: 'Recipient: client@example.com',
    })

    expect(store.permissions.listPending()).toEqual([approval])
    const resolved = store.permissions.resolve(approval.id, 'approved')
    expect(resolved).toMatchObject({
      id: approval.id,
      status: 'approved',
    })
    expect(resolved.resolvedAt).toBeDefined()
    expect(store.permissions.listPending()).toEqual([])
    expect(() => store.permissions.resolve(approval.id, 'denied')).toThrow('already approved')
    store.close()
  })
})
