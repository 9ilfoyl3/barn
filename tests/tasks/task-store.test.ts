import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'

async function openStore(directory: string, key = randomBytes(32)): Promise<SessionStore> {
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(key))
  await store.initialize()
  return store
}

describe('TaskStore', () => {
  it('persists tasks independently from the Session that executes them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const session = store.createSession('Quarterly report')
    const task = store.tasks.create({
      title: 'Prepare the quarterly report',
      origin: 'user',
      sessionId: session.id,
    }, '11111111-1111-4111-8111-111111111111')
    store.close()

    const reopened = await openStore(directory, key)
    expect(reopened.tasks.get(task.id)).toEqual(expect.objectContaining({
      id: task.id,
      title: 'Prepare the quarterly report',
      status: 'queued',
      origin: 'user',
      sessionId: session.id,
    }))
    reopened.close()
  })

  it('enforces the task state machine and records lifecycle timestamps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Analyze feedback', origin: 'user' })

    const running = store.tasks.updateStatus(task.id, { status: 'running', detail: 'Reading source files' })
    expect(running.startedAt).toBeDefined()
    expect(running.finishedAt).toBeUndefined()

    const waiting = store.tasks.updateStatus(task.id, {
      status: 'waiting',
      waitingReason: 'approval',
      detail: 'Approve the generated summary',
    })
    expect(waiting).toMatchObject({
      status: 'waiting',
      waitingReason: 'approval',
      detail: 'Approve the generated summary',
    })

    const completed = store.tasks.updateStatus(task.id, { status: 'completed' })
    expect(completed.status).toBe('completed')
    expect(completed.finishedAt).toBeDefined()
    expect(completed.waitingReason).toBeUndefined()
    expect(() => store.tasks.updateStatus(task.id, { status: 'running' })).toThrow('Invalid task transition')
    store.close()
  })

  it('requires a reason only while a task is waiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Draft follow-up', origin: 'automation' })

    expect(() => store.tasks.updateStatus(task.id, { status: 'waiting' })).toThrow('waiting reason')
    store.tasks.updateStatus(task.id, { status: 'waiting', waitingReason: 'input' })
    expect(() => store.tasks.updateStatus(task.id, {
      status: 'queued',
      waitingReason: 'input',
    })).toThrow('Only a waiting task')
    store.close()
  })

  it('links tasks only to existing Sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Create a presentation', origin: 'user' })
    const session = store.createSession('Presentation')

    expect(() => store.tasks.assignSession(task.id, '11111111-1111-4111-8111-111111111111')).toThrow('Unknown session')
    expect(store.tasks.assignSession(task.id, session.id).sessionId).toBe(session.id)
    expect(store.tasks.assignSession(task.id, null).sessionId).toBeUndefined()
    store.close()
  })

  it('returns interrupted running work to the queue on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const interrupted = store.tasks.create({ title: 'Summarize invoices', origin: 'automation' })
    const untouched = store.tasks.create({ title: 'Waiting on a decision', origin: 'user' })
    store.tasks.updateStatus(interrupted.id, { status: 'running' })
    store.tasks.updateStatus(untouched.id, { status: 'waiting', waitingReason: 'input' })

    expect(store.tasks.recoverInterruptedTasks()).toBe(1)
    expect(store.tasks.get(interrupted.id)).toMatchObject({
      status: 'queued',
      detail: 'Recovered after restart',
    })
    expect(store.tasks.get(untouched.id).status).toBe('waiting')
    store.close()
  })

  it('orders tasks waiting for the user before other active and finished work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const finished = store.tasks.create({ title: 'Finished', origin: 'user' })
    store.tasks.updateStatus(finished.id, { status: 'running' })
    store.tasks.updateStatus(finished.id, { status: 'completed' })
    const proposed = store.tasks.create({ title: 'Proposed', origin: 'automation', status: 'proposed' })
    const waiting = store.tasks.create({ title: 'Waiting', origin: 'user' })
    store.tasks.updateStatus(waiting.id, { status: 'waiting', waitingReason: 'approval' })
    const queued = store.tasks.create({ title: 'Queued', origin: 'user' })

    expect(store.tasks.list().map((task) => task.id)).toEqual([
      waiting.id,
      queued.id,
      proposed.id,
      finished.id,
    ])
    store.close()
  })
})
