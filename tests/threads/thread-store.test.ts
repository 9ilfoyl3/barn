import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { PRIMARY_THREAD_ID } from '../../src/main/threads/thread-store'
import { SessionStore } from '../../src/main/session/session-store'

describe('Principal Thread store', () => {
  it('creates one stable primary thread and persists encrypted visible messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-thread-store-'))
    const path = join(directory, 'sessions.db')
    const key = randomBytes(32)
    const store = new SessionStore(path, new AesGcmEventCipher(key))
    await store.initialize()

    const thread = store.threads.getPrimaryThread()
    expect(thread.id).toBe(PRIMARY_THREAD_ID)
    expect(thread.lastVisibleSeq).toBe(0)

    const first = store.threads.appendPrimaryMessage({
      clientMessageId: 'client-1',
      role: 'user',
      content: 'Plan my morning.',
      metadata: { source: 'desktop' },
      sourceRefs: ['message:seed-1', 'message:seed-1'],
    })
    const second = store.threads.appendPrimaryMessage({
      role: 'assistant',
      content: { type: 'text', text: 'Here is the plan.' },
    })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(first.sourceRefs).toEqual(['message:seed-1'])
    expect(store.threads.getPrimaryThread().lastVisibleSeq).toBe(2)
    store.close()

    const reopened = new SessionStore(path, new AesGcmEventCipher(key))
    await reopened.initialize()
    expect(reopened.threads.getPrimaryThread().lastVisibleSeq).toBe(2)
    expect(reopened.threads.listPrimaryMessages()).toEqual([
      expect.objectContaining({ id: first.id, role: 'user', content: 'Plan my morning.' }),
      expect.objectContaining({ id: second.id, role: 'assistant', content: { type: 'text', text: 'Here is the plan.' } }),
    ])
    reopened.close()
  })

  it('returns the original message for a repeated client id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-thread-idempotent-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()

    const input = {
      clientMessageId: 'request-42',
      role: 'user' as const,
      content: 'Hello',
    }
    const first = store.threads.appendPrimaryMessage(input)
    const second = store.threads.appendPrimaryMessage(input)

    expect(second).toEqual(first)
    expect(store.threads.getPrimaryThread().lastVisibleSeq).toBe(1)
    expect(store.threads.listPrimaryMessages()).toHaveLength(1)
    store.close()
  })

  it('lists messages after a sequence with a bounded limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-thread-page-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()

    for (let index = 0; index < 4; index++) {
      store.threads.appendPrimaryMessage({ role: 'user', content: `Message ${index}` })
    }

    const messages = store.threads.listPrimaryMessages({ afterSeq: 1, limit: 2 })
    expect(messages.map((message) => message.seq)).toEqual([2, 3])
    store.close()
  })

  it('fails closed when the encryption key changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-thread-key-'))
    const path = join(directory, 'sessions.db')
    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    store.threads.appendPrimaryMessage({
      clientMessageId: randomUUID(),
      role: 'user',
      content: 'Secret',
    })
    store.close()

    const wrongKey = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await wrongKey.initialize()
    expect(() => wrongKey.threads.listPrimaryMessages()).toThrow()
    wrongKey.close()
  })
})
