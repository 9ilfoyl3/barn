import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionLiveEvent, Task } from '../../src/shared/models'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskRunner } from '../../src/main/tasks/task-runner'
import { TaskService } from '../../src/main/tasks/task-service'
import { ThreadService } from '../../src/main/threads/thread-service'

class FakeAgent {
  readonly prompt = vi.fn(async (_sessionId: string, _text: string) => {})
  readonly cancel = vi.fn(async (_sessionId: string) => {})
  private readonly listeners = new Set<(event: SessionLiveEvent) => void>()

  onLiveEvent(listener: (event: SessionLiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: SessionLiveEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

async function harness(maxConcurrent = 1, options: {
  now?: () => Date
  threads?: ThreadService
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'barn-task-runner-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const agent = new FakeAgent()
  const runner = new TaskRunner(
    agent,
    tasks,
    sessions,
    { maxConcurrent, ...(options.now === undefined ? {} : { now: options.now }) },
    options.threads,
  )
  return { sessions, tasks, agent, runner }
}

async function waitForTask(tasks: TaskService, taskId: string, predicate: (task: Task) => boolean): Promise<Task> {
  let latest: Task | undefined
  await vi.waitFor(() => {
    latest = tasks.get(taskId)
    expect(predicate(latest)).toBe(true)
  })
  return latest!
}

describe('TaskRunner', () => {
  it('creates a Session, runs a queued task, and completes it', async () => {
    const h = await harness()
    h.runner.start()
    const task = h.tasks.create({
      title: 'Summarize the project notes',
      origin: 'user',
      prompt: 'Read the notes and produce a concise summary.',
    })

    const running = await waitForTask(h.tasks, task.id, (current) => current.status === 'running')
    expect(running.sessionId).toBeDefined()
    expect(h.agent.prompt).toHaveBeenCalledWith(
      running.sessionId,
      'Read the notes and produce a concise summary.',
      [],
      undefined,
      undefined,
      expect.objectContaining({
        projectUserMessage: false,
        visibleMetadata: { taskId: task.id },
      }),
    )

    h.agent.emit({
      type: 'run.status',
      sessionId: running.sessionId!,
      runId: 'run-1',
      status: 'idle',
    })
    await waitForTask(h.tasks, task.id, (current) => current.status === 'completed')
    h.runner.stop()
    h.sessions.close()
  })

  it('waits until scheduledFor before delivering a reminder task', async () => {
    let now = new Date('2026-11-18T00:00:00.000Z')
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-reminder-'))
    const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await sessions.initialize()
    const tasks = new TaskService(sessions.tasks)
    const threads = new ThreadService(sessions.threads)
    const agent = new FakeAgent()
    const runner = new TaskRunner(agent, tasks, sessions, { now: () => now }, threads)
    runner.start()
    const task = tasks.create({
      title: 'Bring the return',
      origin: 'user',
      kind: 'reminder',
      scheduledFor: '2026-11-18T01:00:00.000Z',
      prompt: 'Remind me to bring the return.',
      visiblePrompt: 'Remind me to bring the return.',
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tasks.get(task.id).status).toBe('queued')
    expect(agent.prompt).not.toHaveBeenCalled()

    now = new Date('2026-11-18T01:00:01.000Z')
    runner.kick()
    await waitForTask(tasks, task.id, (current) => current.status === 'completed')
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(threads.listMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Reminder: Remind me to bring the return.',
      metadata: expect.objectContaining({
        taskId: task.id,
        resultCard: expect.objectContaining({ status: 'Reminder' }),
      }),
    })
    runner.stop()
    sessions.close()
  })

  it('waits for input instead of launching a task without instructions', async () => {
    const h = await harness()
    h.runner.start()
    const task = h.tasks.create({ title: 'Plan tomorrow', origin: 'user' })

    await waitForTask(h.tasks, task.id, (current) => current.status === 'waiting')
    expect(h.tasks.get(task.id)).toMatchObject({
      waitingReason: 'input',
      detail: 'Add instructions before this task can run.',
    })
    expect(h.agent.prompt).not.toHaveBeenCalled()
    h.runner.stop()
    h.sessions.close()
  })

  it('marks a task failed when the Agent cannot start the run', async () => {
    const h = await harness()
    h.agent.prompt.mockRejectedValueOnce(new Error('Configure a default model before chatting'))
    h.runner.start()
    const task = h.tasks.create({ title: 'Draft an email', origin: 'user', prompt: 'Draft a short email.' })

    await waitForTask(h.tasks, task.id, (current) => current.status === 'failed')
    expect(h.tasks.get(task.id).detail).toBe('Configure a default model before chatting')
    h.runner.stop()
    h.sessions.close()
  })

  it('marks the active task failed when the Agent Worker crashes', async () => {
    const h = await harness()
    h.runner.start()
    const task = h.tasks.create({ title: 'Analyze the files', origin: 'user', prompt: 'Analyze them.' })
    const running = await waitForTask(h.tasks, task.id, (current) => current.status === 'running')
    h.agent.emit({
      type: 'session.updated',
      session: {
        id: running.sessionId!,
        title: 'Analyze the files',
        status: 'failed',
        hasUnreadResult: true,
        pinned: false,
        createdAt: running.createdAt,
        updatedAt: running.updatedAt,
      },
    })

    await waitForTask(h.tasks, task.id, (current) => current.status === 'failed')
    expect(h.tasks.get(task.id).detail).toBe('The Agent Worker stopped unexpectedly.')
    h.runner.stop()
    h.sessions.close()
  })

  it('cancels the active Session when the task is cancelled', async () => {
    const h = await harness()
    h.runner.start()
    const task = h.tasks.create({ title: 'Long analysis', origin: 'automation', prompt: 'Analyze every file.' })
    const running = await waitForTask(h.tasks, task.id, (current) => current.status === 'running')
    h.tasks.updateStatus(task.id, { status: 'cancelled', detail: 'Cancelled by the user.' })

    await vi.waitFor(() => expect(h.agent.cancel).toHaveBeenCalledWith(running.sessionId))
    expect(h.tasks.get(task.id).status).toBe('cancelled')
    h.runner.stop()
    h.sessions.close()
  })

  it('keeps one task running at the configured concurrency', async () => {
    const h = await harness(1)
    h.runner.start()
    const first = h.tasks.create({ title: 'First', origin: 'user', prompt: 'Run first.' })
    const second = h.tasks.create({ title: 'Second', origin: 'user', prompt: 'Run second.' })

    await vi.waitFor(() => {
      const statuses = [h.tasks.get(first.id).status, h.tasks.get(second.id).status]
      expect(statuses.filter((status) => status === 'running')).toHaveLength(1)
      expect(statuses.filter((status) => status === 'queued')).toHaveLength(1)
    })
    const runningTask = h.tasks.get(first.id).status === 'running' ? h.tasks.get(first.id) : h.tasks.get(second.id)
    const queuedTask = runningTask.id === first.id ? second : first
    h.agent.emit({
      type: 'run.status',
      sessionId: runningTask.sessionId!,
      runId: 'run-first',
      status: 'idle',
    })
    await waitForTask(h.tasks, queuedTask.id, (current) => current.status === 'running')
    h.runner.stop()
    h.sessions.close()
  })
})
