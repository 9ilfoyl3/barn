import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskGuardService, type TaskGuardRunner } from '../../src/main/tasks/task-guard'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-task-guard-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const active = new Set<string>()
  const nudge = vi.fn(async (taskId: string, _text: string) => active.has(taskId))
  const guardPause = vi.fn(async (taskId: string, detail: string) => {
    if (!active.delete(taskId)) return false
    tasks.updateStatus(taskId, { status: 'waiting', waitingReason: 'input', detail })
    sessions.taskRuns.finishLatest(taskId, 'waiting', detail)
    return true
  })
  const runner: TaskGuardRunner = {
    isActive: (taskId) => active.has(taskId),
    activeSnapshot: () => [...active].map((taskId) => {
      const task = tasks.get(taskId)
      return { taskId, sessionId: task.sessionId!, runId: sessions.taskRuns.latest(taskId)!.id }
    }),
    nudge,
    guardPause,
  }
  let now = new Date('2026-11-26T00:00:00.000Z')
  const guard = new TaskGuardService(tasks, sessions.taskRuns, runner, {
    intervalMs: 0,
    silentMs: 10_000,
    graceMs: 5_000,
    now: () => now,
  })
  return {
    sessions,
    tasks,
    active,
    nudge,
    guardPause,
    guard,
    current: () => now,
    advance: (ms: number) => { now = new Date(now.getTime() + ms) },
  }
}

function runningTask(h: Awaited<ReturnType<typeof harness>>, title = 'Silent task') {
  const task = h.tasks.create({ title, origin: 'user', prompt: 'Do careful work.', status: 'queued' })
  const session = h.sessions.createSession(task.title)
  h.tasks.assignSession(task.id, session.id)
  h.tasks.updateStatus(task.id, { status: 'running', detail: 'Task execution started.' })
  const run = h.sessions.taskRuns.start({ taskId: task.id, sessionId: session.id, leaseOwner: 'desktop', leaseMs: 60_000, now: h.current() })
  h.active.add(task.id)
  return { task, session, run }
}

describe('TaskGuardService', () => {
  it('nudges a silent run once, then pauses it only after the grace period', async () => {
    const h = await harness()
    const { task, run } = runningTask(h)
    h.advance(10_001)
    expect(await h.guard.inspectNow()).toMatchObject({ checked: 1, nudged: 1, paused: 0 })
    expect(h.nudge).toHaveBeenCalledWith(task.id, expect.stringContaining('Guard check'))
    expect(h.sessions.taskRuns.get(run.id)).toMatchObject({ guardState: 'nudged', guardAttempts: 1 })

    h.advance(4_000)
    expect((await h.guard.inspectNow()).paused).toBe(0)
    h.advance(1_001)
    expect((await h.guard.inspectNow()).paused).toBe(1)
    expect(h.guardPause).toHaveBeenCalledWith(task.id, expect.stringContaining('no progress'))
    expect(h.tasks.get(task.id)).toMatchObject({ status: 'waiting', waitingReason: 'input' })
    expect(h.sessions.taskRuns.get(run.id).status).toBe('waiting')
    h.sessions.close()
  })

  it('pauses a running Task whose worker ownership is gone', async () => {
    const h = await harness()
    const { task, run } = runningTask(h, 'Orphaned task')
    h.active.delete(task.id)
    expect(await h.guard.inspectNow()).toMatchObject({ checked: 1, paused: 1 })
    expect(h.tasks.get(task.id)).toMatchObject({
      status: 'waiting',
      waitingReason: 'input',
      detail: expect.stringContaining('no worker owns the run'),
    })
    expect(h.sessions.taskRuns.get(run.id)).toMatchObject({ status: 'failed' })
    h.sessions.close()
  })

  it('leaves a recently progressing run alone', async () => {
    const h = await harness()
    const { run } = runningTask(h, 'Healthy task')
    h.advance(5_000)
    h.sessions.taskRuns.heartbeat(run.id, 60_000, true, new Date('2026-11-26T00:00:05.000Z'))
    h.advance(6_000)
    expect(await h.guard.inspectNow()).toMatchObject({ checked: 1, nudged: 0, paused: 0 })
    expect(h.nudge).not.toHaveBeenCalled()
    h.sessions.close()
  })
})
