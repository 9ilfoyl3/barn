import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RouterLiveEvent } from '../../src/shared/models'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { ThreadService } from '../../src/main/threads/thread-service'
import { TaskService } from '../../src/main/tasks/task-service'
import { RouterService } from '../../src/main/router/router-service'
import type { RouterDecision, RouterDecisionEngine, RouterDecisionInput } from '../../src/main/router/router-decision'

class FakeDecisionEngine implements RouterDecisionEngine {
  readonly decide = vi.fn(async (_input: RouterDecisionInput): Promise<RouterDecision> => replyDecision())

  setDecider(decide: (input: RouterDecisionInput) => Promise<RouterDecision>): void {
    this.decide.mockImplementation(decide)
  }
}

async function harness(options: {
  decide?: (input: RouterDecisionInput) => Promise<RouterDecision>
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'barn-router-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const threads = new ThreadService(sessions.threads)
  const tasks = new TaskService(sessions.tasks)
  const decisions = new FakeDecisionEngine()
  if (options.decide !== undefined) decisions.setDecider(options.decide)
  const router = new RouterService(
    sessions.router,
    threads,
    sessions,
    tasks,
    decisions,
    {
      createRequestId: (() => {
        let index = 0
        return () => `00000000-0000-4000-8000-${String(++index).padStart(12, '0')}`
      })(),
      now: () => new Date('2026-11-18T00:00:00.000Z'),
      timezone: 'Asia/Shanghai',
    },
  )
  return { sessions, threads, tasks, decisions, router }
}

describe('RouterService', () => {
  it('accepts more messages while the first Router decision is still running', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const h = await harness({
      decide: async () => {
        if (h.decisions.decide.mock.calls.length === 1) await firstBlocked
        return replyDecision('Router reply')
      },
    })
    h.router.start()
    const first = await h.router.submit({ text: 'first message' })
    await vi.waitFor(() => expect(h.decisions.decide).toHaveBeenCalledTimes(1))
    const second = await h.router.submit({ text: 'second message' })

    expect(second.request.status).toBe('queued')
    expect(h.router.getSnapshot()).toMatchObject({
      queuedCount: 1,
      activeRequest: expect.objectContaining({ id: first.request.id, status: 'routing' }),
    })
    releaseFirst?.()
    await vi.waitFor(() => expect(h.decisions.decide).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(h.router.getSnapshot().requests.every((request) => request.status === 'completed')).toBe(true))
    expect(h.router.getSnapshot().requests.map((request) => request.sequence)).toEqual([1, 2])
    h.router.stop()
    h.sessions.close()
  })

  it('projects a direct reply without creating a Session or Task', async () => {
    const h = await harness()
    h.router.start()
    const submitted = await h.router.submit({ text: 'What is this?' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(h.tasks.list()).toEqual([])
    expect(h.sessions.listSessions()).toEqual([])
    const messages = h.threads.listMessages()
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Direct Router reply',
      metadata: expect.objectContaining({ routerRequestId: submitted.request.id }),
    })
    h.router.stop()
    h.sessions.close()
  })

  it('creates a durable task from a validated task.create decision', async () => {
    const h = await harness({ decide: async () => taskDecision() })
    h.router.start()
    await h.router.submit({ text: 'Research the vendor options' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    const request = h.router.getSnapshot().requests[0]!
    expect(request).toMatchObject({ decisionKind: 'create_task', taskId: expect.any(String) })
    const task = h.tasks.get(request.taskId!)
    expect(task).toMatchObject({ status: 'queued', kind: 'work' })
    expect(h.threads.listMessages().at(-1)).toMatchObject({
      role: 'assistant',
      metadata: expect.objectContaining({
        taskId: task.id,
        resultCard: expect.objectContaining({ kind: 'task', title: task.title }),
      }),
    })
    h.router.stop()
    h.sessions.close()
  })

  it('creates a scheduled reminder task only when the Router chooses schedule.create', async () => {
    const h = await harness({ decide: async () => scheduleDecision() })
    h.router.start()
    await h.router.submit({ text: '提醒我明天要带退货的衣服' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    const request = h.router.getSnapshot().requests[0]!
    const task = h.tasks.get(request.taskId!)
    expect(task).toMatchObject({
      kind: 'reminder',
      scheduledFor: '2026-11-19T01:00:00.000Z',
      visiblePrompt: 'Remind me to bring the clothes for return.',
    })
    expect(h.threads.listMessages().at(-1)?.metadata.resultCard).toMatchObject({
      status: 'Scheduled',
      title: task.title,
    })
    h.router.stop()
    h.sessions.close()
  })

  it('deduplicates repeated submissions with the same client message id', async () => {
    const h = await harness()
    h.router.start()
    const first = await h.router.submit({ text: 'hello', clientMessageId: 'client-1' })
    const second = await h.router.submit({ text: 'hello', clientMessageId: 'client-1' })
    expect(second.request.id).toBe(first.request.id)
    expect(h.router.getSnapshot().requests).toHaveLength(1)
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(h.threads.listMessages()).toHaveLength(2)
    h.router.stop()
    h.sessions.close()
  })

  it('applies model-driven task.cancel and task.update tools', async () => {
    const h = await harness()
    const task = h.tasks.create({
      title: 'Draft the update',
      origin: 'user',
      prompt: 'Draft a project update.',
      visiblePrompt: 'Draft a project update.',
    })
    let nextDecision: RouterDecision = {
      action: 'update_task',
      taskId: task.id,
      instruction: 'Keep it under 150 words.',
      confidence: 0.95,
      rationaleCodes: ['task_update'],
      memoryRefs: [],
    }
    h.decisions.setDecider(async () => nextDecision)
    h.router.start()
    await h.router.submit({ text: 'Keep the update short.' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(h.tasks.get(task.id).prompt).toContain('Additional instruction:\nKeep it under 150 words.')

    nextDecision = {
      action: 'cancel_task',
      taskId: task.id,
      reason: 'The user no longer needs it.',
      confidence: 0.95,
      rationaleCodes: ['task_cancel'],
      memoryRefs: [],
    }
    await h.router.submit({ text: 'Cancel that task.' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[1]?.status).toBe('completed'))
    expect(h.tasks.get(task.id).status).toBe('cancelled')
    h.router.stop()
    h.sessions.close()
  })

  it('cancels a queued request before the serial lane reaches it', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const h = await harness({
      decide: async () => {
        if (h.decisions.decide.mock.calls.length === 1) await firstBlocked
        return replyDecision()
      },
    })
    h.router.start()
    await h.router.submit({ text: 'first message' })
    await vi.waitFor(() => expect(h.decisions.decide).toHaveBeenCalledTimes(1))
    const second = await h.router.submit({ text: 'second message' })
    const cancelled = await h.router.cancel(second.request.id)
    expect(cancelled.status).toBe('cancelled')
    releaseFirst?.()
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(h.decisions.decide).toHaveBeenCalledTimes(1)
    expect(h.router.getSnapshot().requests[1]?.status).toBe('cancelled')
    h.router.stop()
    h.sessions.close()
  })

  it('recovers an expired Router lease back to queued', async () => {
    const h = await harness()
    const submitted = await h.router.submit({ text: 'recover me' })
    const claimed = h.sessions.router.claimNext('worker-a', 1_000, new Date('2026-11-18T00:00:00.000Z'))
    expect(claimed?.request.id).toBe(submitted.request.id)
    const recovered = h.sessions.router.recoverExpired(new Date('2026-11-18T00:01:01.000Z'))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: submitted.request.id, status: 'queued' })
    h.sessions.close()
  })

  it('emits queue updates and validates cancellation', async () => {
    const h = await harness()
    const events: RouterLiveEvent[] = []
    h.router.onEvent((event) => events.push(event))
    h.router.start()
    await h.router.submit({ text: 'hello' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['router.request-updated']))
    h.router.stop()
    h.sessions.close()
  })
})

function replyDecision(text = 'Direct Router reply'): RouterDecision {
  return {
    action: 'reply',
    text,
    confidence: 0.95,
    rationaleCodes: ['router_reply'],
    memoryRefs: [],
  }
}

function taskDecision(): RouterDecision {
  return {
    action: 'create_task',
    title: 'Research the vendor options',
    confidence: 0.95,
    rationaleCodes: ['router_task'],
    memoryRefs: [],
    taskContract: {
      objective: 'Research the vendor options',
      deliverable: 'A comparison',
      constraints: [],
      inputRefs: [],
      sourceRefs: [],
      acceptanceCriteria: ['Compare supported options'],
      forbiddenActions: [],
      risk: 'none',
      executionLane: 'background',
      expectedArtifacts: [],
    },
  }
}

function scheduleDecision(): RouterDecision {
  return {
    action: 'schedule',
    title: 'Bring the clothes for return',
    text: 'Remind me to bring the clothes for return.',
    scheduledFor: '2026-11-19T01:00:00.000Z',
    timezone: 'Asia/Shanghai',
    confidence: 0.95,
    rationaleCodes: ['router_reminder'],
    memoryRefs: [],
  }
}
