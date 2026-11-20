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
        userActorRole: 'router',
        assistantActorRole: 'worker',
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

  it('projects the final task answer into the principal thread with its Router request', async () => {
    const h = await harness()
    const threads = new ThreadService(h.sessions.threads)
    h.runner.stop()
    const runner = new TaskRunner(
      h.agent,
      h.tasks,
      h.sessions,
      {
        maxConcurrent: 1,
        routerRequestIdForTask: () => 'router-task-result',
      },
      threads,
    )
    runner.start()
    const task = h.tasks.create({
      title: 'Summarize the project notes',
      origin: 'user',
      prompt: 'Read the notes and produce a concise summary.',
    })
    const running = await waitForTask(h.tasks, task.id, (current) => current.status === 'running')
    h.sessions.append(running.sessionId!, [{
      type: 'agent.message',
      data: {
        message: {
          role: 'assistant',
          content: 'The notes cover three decisions and two follow-ups.',
          timestamp: Date.now(),
        },
        actorRole: 'worker',
      },
      actor: { kind: 'agent', id: 'barn' },
    }, {
      type: 'agent.message',
      data: {
        message: {
          role: 'assistant',
          content: 'Router coordination reply.',
          timestamp: Date.now(),
        },
        actorRole: 'router',
      },
      actor: { kind: 'agent', id: 'router' },
    }])
    h.agent.emit({
      type: 'run.status',
      sessionId: running.sessionId!,
      runId: 'run-result',
      status: 'idle',
    })

    await waitForTask(h.tasks, task.id, (current) => current.status === 'completed')
    await vi.waitFor(() => {
      expect(threads.listMessages().at(-1)).toMatchObject({
        role: 'assistant',
        content: 'The notes cover three decisions and two follow-ups.',
        metadata: expect.objectContaining({
          taskId: task.id,
          taskResult: true,
          routerRequestId: 'router-task-result',
        }),
      })
    })
    runner.stop()
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
        routineId: task.id,
        routineDelivery: true,
      }),
    })
    runner.stop()
    sessions.close()
  })

  it('runs due routines even when future routines are queued', async () => {
    let now = new Date('2026-11-19T08:00:02.000Z')
    const h = await harness(1, { now: () => now })
    h.runner.start()
    const future = h.tasks.create({
      title: 'Tomorrow reminder',
      origin: 'user',
      kind: 'reminder',
      scheduledFor: '2026-11-20T01:00:00.000Z',
      prompt: 'Tomorrow reminder.',
      visiblePrompt: 'Tomorrow reminder.',
    })
    const due = h.tasks.create({
      title: 'Due now',
      origin: 'user',
      kind: 'reminder',
      scheduledFor: '2026-11-19T07:59:00.000Z',
      prompt: 'Due now.',
      visiblePrompt: 'Due now.',
    })

    await waitForTask(h.tasks, due.id, (current) => current.status === 'completed')
    expect(h.tasks.get(future.id).status).toBe('queued')
    now = new Date('2026-11-20T01:00:01.000Z')
    h.runner.kick()
    await waitForTask(h.tasks, future.id, (current) => current.status === 'completed')
    h.runner.stop()
    h.sessions.close()
  })

  it('reschedules a recurring routine after delivering the current occurrence', async () => {
    const h = await harness()
    const threads = new ThreadService(h.sessions.threads)
    h.runner.stop()
    const runner = new TaskRunner(h.agent, h.tasks, h.sessions, { maxConcurrent: 1 }, threads)
    runner.start()
    const previous = new Date(Date.now() - 1_000).toISOString()
    const task = h.tasks.create({
      title: 'Stand up',
      origin: 'user',
      kind: 'reminder',
      scheduledFor: previous,
      recurrence: 'daily',
      timezone: 'Asia/Shanghai',
      prompt: 'Stand up for a moment.',
      visiblePrompt: 'Stand up for a moment.',
    })

    await vi.waitFor(() => {
      const current = h.tasks.get(task.id)
      expect(current.status).toBe('queued')
      expect(current.scheduledFor).toBeDefined()
      expect(new Date(current.scheduledFor!).getTime()).toBeGreaterThan(Date.now())
    })
    expect(h.tasks.get(task.id).recurrence).toBe('daily')
    expect(threads.listMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Reminder: Stand up for a moment.',
      metadata: expect.objectContaining({ routineDelivery: true }),
    })
    runner.stop()
    h.sessions.close()
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

  it('cancels the old run and requeues a task when Router reroutes it', async () => {
    const h = await harness()
    h.runner.start()
    const task = h.tasks.create({
      title: 'Search recent news',
      origin: 'user',
      prompt: 'Search recent news on Xinhua.',
    })
    const firstRun = await waitForTask(h.tasks, task.id, (current) => current.status === 'running')

    h.tasks.reroute(task.id, 'Use Baidu instead of Xinhua.')
    await vi.waitFor(() => expect(h.agent.cancel).toHaveBeenCalledWith(firstRun.sessionId))
    const reroutedRun = await vi.waitFor(async () => {
      const current = h.tasks.get(task.id)
      expect(current.status).toBe('running')
      expect(h.agent.prompt).toHaveBeenCalledTimes(2)
      expect(current.sessionId).toBe(firstRun.sessionId)
      return current
    })
    expect(reroutedRun.prompt).toContain('Use Baidu instead of Xinhua.')
    expect(h.agent.prompt).toHaveBeenLastCalledWith(
      reroutedRun.sessionId,
      'Use Baidu instead of Xinhua.',
      [],
      undefined,
      undefined,
      expect.objectContaining({
        assistantActorRole: 'router',
        recordUserMessage: false,
        projectAssistantMessage: false,
      }),
    )
    h.agent.emit({
      type: 'run.status',
      sessionId: reroutedRun.sessionId!,
      runId: 'run-router',
      status: 'idle',
    })
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(3))
    expect(h.agent.prompt).toHaveBeenLastCalledWith(
      reroutedRun.sessionId,
      'Use Baidu instead of Xinhua.',
      [],
      undefined,
      'Use Baidu instead of Xinhua.',
      expect.objectContaining({
        assistantActorRole: 'worker',
        recordUserMessage: false,
        projectAssistantMessage: false,
      }),
    )
    h.agent.emit({
      type: 'run.status',
      sessionId: reroutedRun.sessionId!,
      runId: 'run-rerouted',
      status: 'idle',
    })
    await waitForTask(h.tasks, task.id, (current) => current.status === 'completed')
    h.runner.stop()
    h.sessions.close()
  })

  it('does not fail a requeued task when the cancelled run rejects its prompt', async () => {
    const h = await harness()
    let rejectFirstPrompt: ((error: Error) => void) | undefined
    h.agent.prompt.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirstPrompt = reject
    }))
    h.runner.start()
    const task = h.tasks.create({ title: 'Search news', origin: 'user', prompt: 'Search on Xinhua.' })
    const firstRun = await waitForTask(h.tasks, task.id, (current) => current.status === 'running')

    h.tasks.reroute(task.id, 'Use Baidu instead.')
    await vi.waitFor(() => expect(h.agent.cancel).toHaveBeenCalledWith(firstRun.sessionId))
    rejectFirstPrompt?.(new Error('Worker cancelled'))
    await vi.waitFor(() => {
      expect(h.agent.prompt).toHaveBeenCalledTimes(2)
      expect(h.tasks.get(task.id).status).toBe('running')
    })
    const reroutedRun = h.tasks.get(task.id)
    expect(reroutedRun.sessionId).toBe(firstRun.sessionId)

    h.agent.emit({
      type: 'run.status',
      sessionId: reroutedRun.sessionId!,
      runId: 'run-router-after-cancel',
      status: 'idle',
    })
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(3))
    h.agent.emit({
      type: 'run.status',
      sessionId: reroutedRun.sessionId!,
      runId: 'run-after-cancel-race',
      status: 'idle',
    })
    await waitForTask(h.tasks, task.id, (current) => current.status === 'completed')
    h.runner.stop()
    h.sessions.close()
  })

  it('runs independent tasks in parallel up to the configured concurrency', async () => {
    const h = await harness(2)
    h.runner.start()
    const first = h.tasks.create({ title: 'First', origin: 'user', prompt: 'Run first.' })
    const second = h.tasks.create({ title: 'Second', origin: 'user', prompt: 'Run second.' })

    await vi.waitFor(() => {
      expect(h.tasks.get(first.id).status).toBe('running')
      expect(h.tasks.get(second.id).status).toBe('running')
    })
    expect(h.agent.prompt).toHaveBeenCalledTimes(2)
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
