import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness(key = randomBytes(32)) {
  const directory = await mkdtemp(join(tmpdir(), 'barn-task-run-store-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(key))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  return { directory, key, sessions, tasks }
}

describe('TaskRunStore', () => {
  it('persists attempts, heartbeat, guard state, and encrypted errors', async () => {
    const h = await harness()
    const task = h.tasks.create({ title: 'Background task', origin: 'user', prompt: 'Do work.', status: 'queued' })
    const session = h.sessions.createSession(task.title)
    h.tasks.assignSession(task.id, session.id)
    const first = h.sessions.taskRuns.start({ taskId: task.id, sessionId: session.id, leaseOwner: 'desktop', leaseMs: 60_000 })
    expect(first).toMatchObject({ attempt: 1, status: 'running', guardState: 'watching' })
    const tick = new Date(Date.parse(first.startedAt) + 5_000)
    expect(h.sessions.taskRuns.heartbeat(first.id, 60_000, true, tick).lastProgressAt).toBe(tick.toISOString())
    expect(h.sessions.taskRuns.guard(first.id, 'nudged', tick)).toMatchObject({ guardState: 'nudged', guardAttempts: 1 })
    expect(h.sessions.taskRuns.setStatus(first.id, 'failed', 'Private provider failure.', tick)).toMatchObject({ status: 'failed' })
    expect(h.sessions.taskRuns.latest(task.id)?.lastError).toBe('Private provider failure.')
    h.sessions.close()

    const reopened = new SessionStore(join(h.directory, 'sessions.db'), new AesGcmEventCipher(h.key))
    await reopened.initialize()
    expect(reopened.taskRuns.latest(task.id)).toMatchObject({
      status: 'failed',
      guardState: 'nudged',
      lastError: 'Private provider failure.',
    })
    reopened.close()
  })

  it('recovers running attempts after a host restart', async () => {
    const h = await harness()
    const task = h.tasks.create({ title: 'Interrupted task', origin: 'user', prompt: 'Do work.', status: 'queued' })
    const session = h.sessions.createSession(task.title)
    const run = h.sessions.taskRuns.start({ taskId: task.id, sessionId: session.id, leaseOwner: 'desktop', leaseMs: 60_000 })
    expect(h.sessions.taskRuns.recoverInterruptedRuns()).toBe(1)
    expect(h.sessions.taskRuns.get(run.id)).toMatchObject({
      status: 'failed',
      lastError: 'Host restarted before the run settled.',
    })
    h.sessions.close()
  })
})
