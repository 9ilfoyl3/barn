import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { ThreadService } from '../../src/main/threads/thread-service'

describe('ThreadService', () => {
  it('returns a snapshot and emits each durable append', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-thread-service-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const service = new ThreadService(store.threads)
    const events: string[] = []
    const unsubscribe = service.onEvent((event) => events.push(`${event.type}:${event.message.seq}`))

    const message = service.appendMessage({ role: 'user', content: 'Hello' })
    unsubscribe()

    expect(service.getSnapshot()).toEqual({
      thread: expect.objectContaining({ lastVisibleSeq: 1 }),
      messages: [expect.objectContaining({ id: message.id, content: 'Hello' })],
    })
    expect(events).toEqual(['thread.message-appended:1'])
    store.close()
  })
})
