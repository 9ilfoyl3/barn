import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../src/main/session/event-cipher'
import { SessionStore } from '../src/main/session/session-store'

describe('SessionStore', () => {
  it('creates sessions and appends encrypted contiguous events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const key = randomBytes(32)
    const store = new SessionStore(
      join(directory, 'sessions.db'),
      new AesGcmEventCipher(key),
    )
    await store.initialize()

    const session = store.createSession('Review probation case')
    store.append(session.id, [{
      type: 'message/user',
      data: { text: 'Summarize the attached project notes.' },
      actor: { kind: 'user', id: 'desktop-user' },
    }, {
      type: 'message/assistant',
      data: { text: 'I will prepare the review.' },
    }])

    const events = store.read(session.id)
    expect(events.map((event) => event.seq)).toEqual([1, 2])
    expect(events[0]?.data).toEqual({
      text: 'Summarize the attached project notes.',
    })
    expect(store.listSessions()[0]).toEqual(expect.objectContaining({
      id: session.id,
      title: 'Review probation case',
    }))
    store.close()
  })

  it('persists the current working directory for a Session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const path = pathForSessions(directory)
    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const session = store.createSession('Workspace session', undefined, directory)
    store.append(session.id, [{ type: 'message/user', data: { text: 'Inspect this folder' } }])
    expect(store.getSession(session.id).workingDirectory).toBe(directory)
    store.close()

    const reopened = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await reopened.initialize()
    expect(reopened.listSessions()[0]?.workingDirectory).toBe(directory)
    reopened.close()
  })

  it('persists unread results until the Session is opened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const path = pathForSessions(directory)
    const key = randomBytes(32)
    const store = new SessionStore(path, new AesGcmEventCipher(key))
    await store.initialize()
    const session = store.createSession('Unread result')
    store.append(session.id, [{ type: 'message/user', data: { text: 'Run in the background' } }])

    expect(store.getSession(session.id).hasUnreadResult).toBe(false)
    expect(store.markResultUnread(session.id).hasUnreadResult).toBe(true)
    store.close()

    const reopened = new SessionStore(path, new AesGcmEventCipher(key))
    await reopened.initialize()
    expect(reopened.getSession(session.id).hasUnreadResult).toBe(true)
    expect(reopened.markResultRead(session.id).hasUnreadResult).toBe(false)
    reopened.close()
  })

  it('persists pinned and archived Session organization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const path = pathForSessions(directory)
    const key = randomBytes(32)
    const store = new SessionStore(path, new AesGcmEventCipher(key))
    await store.initialize()

    const pinned = store.createSession('Pinned conversation')
    const recent = store.createSession('Recent conversation')
    const archived = store.createSession('Archived conversation')
    for (const session of [pinned, recent, archived]) {
      store.append(session.id, [{ type: 'message/user', data: { text: session.title } }])
    }

    store.setPinned(pinned.id, true)
    store.markResultUnread(archived.id)
    const archivedSession = store.setArchived(archived.id, true)
    expect(archivedSession.archivedAt).toEqual(expect.any(String))
    expect(archivedSession.hasUnreadResult).toBe(false)
    expect(archivedSession.pinned).toBe(false)
    expect(store.listSessions().map((session) => session.id)).toEqual([pinned.id, recent.id, archived.id])
    store.close()

    const reopened = new SessionStore(path, new AesGcmEventCipher(key))
    await reopened.initialize()
    const sessions = reopened.listSessions()
    expect(sessions.find((session) => session.id === pinned.id)?.pinned).toBe(true)
    expect(sessions.find((session) => session.id === archived.id)?.archivedAt).toEqual(expect.any(String))
    expect(sessions.map((session) => session.id)).toEqual([pinned.id, recent.id, archived.id])
    reopened.close()
  })

  it('recovers sessions left running after an interrupted app shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const store = new SessionStore(pathForSessions(directory), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const session = store.createSession()
    store.updateStatus(session.id, 'running')

    expect(store.recoverInterruptedSessions()).toBe(1)
    expect(store.getSession(session.id).status).toBe('idle')
    store.close()
  })

  it('keeps sessions without events out of history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const store = new SessionStore(pathForSessions(directory), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()

    const session = store.createSession('Draft session')
    expect(store.listSessions()).toHaveLength(0)

    store.append(session.id, [{ type: 'message/user', data: { text: 'Start the conversation' } }])

    expect(store.listSessions()).toHaveLength(1)
    expect(store.listSessions()[0]?.id).toBe(session.id)
    store.close()
  })

  it('removes duplicate empty sessions left by earlier versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const path = pathForSessions(directory)
    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const conversation = store.createSession('Existing conversation')
    store.append(conversation.id, [{ type: 'message/user', data: { text: 'Keep this session' } }])
    store.createSession('First empty session')
    store.createSession('Second empty session')
    store.close()

    const reopened = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await reopened.initialize()

    const sessions = reopened.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe(conversation.id)
    reopened.close()
  })

  it('fails closed when the encryption key changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-session-store-'))
    const path = join(directory, 'sessions.db')
    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const session = store.createSession()
    store.append(session.id, [{ type: 'message/user', data: { text: 'secret' } }])
    store.close()

    const wrongKeyStore = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await wrongKeyStore.initialize()
    expect(() => wrongKeyStore.read(session.id)).toThrow()
    wrongKeyStore.close()
  })
})

function pathForSessions(directory: string): string {
  return join(directory, 'sessions.db')
}
