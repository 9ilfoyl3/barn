import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskLiveEvent } from '../../src/shared/models'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskService } from '../../src/main/tasks/task-service'

describe('TaskService', () => {
  it('publishes every task mutation as a typed live event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-service-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const tasks = new TaskService(store.tasks)
    const events: TaskLiveEvent[] = []
    const unsubscribe = tasks.onEvent((event) => events.push(event))

    const task = tasks.create({ title: 'Review the proposal', origin: 'user' })
    const session = store.createSession('Proposal review')
    tasks.assignSession(task.id, session.id)
    tasks.updateStatus(task.id, { status: 'running' })
    unsubscribe()
    tasks.updateStatus(task.id, { status: 'completed' })

    const taskEvents = events.filter((event) => event.type === 'task.updated')
    expect(taskEvents).toHaveLength(3)
    expect(taskEvents.map((event) => event.task.status)).toEqual(['queued', 'queued', 'running'])
    expect(taskEvents[1]?.task.sessionId).toBe(session.id)
    store.close()
  })
})
