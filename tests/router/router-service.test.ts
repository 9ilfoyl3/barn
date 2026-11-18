import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentPromptOptions,
  AttachmentDescriptor,
  DelegationDecision,
  RouterLiveEvent,
  SessionSummary,
} from '../../src/shared/models'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { ThreadService } from '../../src/main/threads/thread-service'
import { TaskService } from '../../src/main/tasks/task-service'
import { RouterService } from '../../src/main/router/router-service'

class FakeRouterAgent {
  readonly prompt = vi.fn(async (
    executionSessionId: string,
    _text: string,
    _attachments: AttachmentDescriptor[] = [],
    _workingDirectory?: string,
    _visibleText?: string,
    options: AgentPromptOptions = {},
  ): Promise<SessionSummary> => {
    const requestId = options.visibleMetadata?.routerRequestId
    if (typeof requestId === 'string') {
      this.threads.appendMessage({
        clientMessageId: `fake-reply:${requestId}:${executionSessionId}`,
        role: 'assistant',
        content: `Reply for ${requestId}`,
        metadata: { routerRequestId: requestId },
        sourceRefs: [`router:${requestId}`],
      })
    }
    return {
      id: executionSessionId,
      title: 'Router',
      status: 'idle',
      hasUnreadResult: false,
      pinned: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
  })

  readonly cancel = vi.fn(async (_sessionId: string) => {})

  constructor(private readonly threads: ThreadService) {}
}

async function harness(options: {
  classify?: (input: { text: string }) => DelegationDecision
  prompt?: (requestId: string) => Promise<void>
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'barn-router-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const threads = new ThreadService(sessions.threads)
  const tasks = new TaskService(sessions.tasks)
  const agent = new FakeRouterAgent(threads)
  if (options.prompt !== undefined) {
    agent.prompt.mockImplementation(async (
      executionSessionId: string,
      _text: string,
      _attachments: AttachmentDescriptor[] = [],
      _workingDirectory?: string,
      _visibleText?: string,
      promptOptions: AgentPromptOptions = {},
    ) => {
      const requestId = String(promptOptions.visibleMetadata?.routerRequestId)
      await options.prompt!(requestId)
      threads.appendMessage({
        clientMessageId: `fake-reply:${requestId}:${executionSessionId}`,
        role: 'assistant',
        content: `Reply for ${requestId}`,
        metadata: { routerRequestId: requestId },
      })
      return {
        id: executionSessionId,
        title: 'Router',
        status: 'idle',
        hasUnreadResult: false,
        pinned: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    })
  }
  const router = new RouterService(
    sessions.router,
    threads,
    sessions,
    tasks,
    agent,
    {
      classify: options.classify ?? (() => answerDecision()),
      createRequestId: (() => {
        let index = 0
        return () => `00000000-0000-4000-8000-${String(++index).padStart(12, '0')}`
      })(),
      createExecutionSessionId: (() => {
        let index = 0
        return () => `10000000-0000-4000-8000-${String(++index).padStart(12, '0')}`
      })(),
    },
  )
  return { sessions, threads, tasks, agent, router }
}

describe('RouterService', () => {
  it('accepts more messages while the first Router turn is still running', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const h = await harness({
      prompt: (requestId) => requestId.endsWith('0001') ? firstBlocked : Promise.resolve(),
    })
    h.router.start()
    const first = await h.router.submit({ text: 'first message' })
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(1))
    const second = await h.router.submit({ text: 'second message' })

    expect(second.request.status).toBe('queued')
    expect(h.router.getSnapshot()).toMatchObject({
      queuedCount: 1,
      activeRequest: expect.objectContaining({ id: first.request.id, status: 'routing' }),
    })
    releaseFirst?.()
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(h.router.getSnapshot().requests.every((request) => request.status === 'completed')).toBe(true))
    expect(h.router.getSnapshot().requests.map((request) => request.sequence)).toEqual([1, 2])
    h.router.stop()
    h.sessions.close()
  })

  it('creates a durable task and an anchored visible result for delegated work', async () => {
    const h = await harness({
      classify: () => taskDecision(),
    })
    h.router.start()
    const submitted = await h.router.submit({ text: 'Research the vendor options' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    const request = h.router.getSnapshot().requests[0]!
    expect(request).toMatchObject({
      decisionKind: 'create_task',
      taskId: expect.any(String),
    })
    expect(h.agent.prompt).not.toHaveBeenCalled()
    const task = h.tasks.get(request.taskId!)
    expect(task).toMatchObject({ status: 'queued', origin: 'user' })
    const visible = h.threads.listMessages().findLast((message) => message.metadata.routerRequestId === submitted.request.id)
    expect(visible).toMatchObject({
      role: 'assistant',
      metadata: expect.objectContaining({
        taskId: task.id,
        resultCard: expect.objectContaining({ kind: 'task', title: task.title }),
      }),
    })
    h.router.stop()
    h.sessions.close()
  })

  it('cancels a queued request before the serial lane reaches it', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const h = await harness({
      prompt: (requestId) => requestId.endsWith('0001') ? firstBlocked : Promise.resolve(),
    })
    h.router.start()
    await h.router.submit({ text: 'first message' })
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(1))
    const second = await h.router.submit({ text: 'second message' })
    const cancelled = await h.router.cancel(second.request.id)
    expect(cancelled.status).toBe('cancelled')
    releaseFirst?.()
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(h.agent.prompt).toHaveBeenCalledTimes(1)
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

  it('emits queue and execution events for UI projection', async () => {
    const h = await harness()
    const events: RouterLiveEvent[] = []
    h.router.onEvent((event) => events.push(event))
    h.router.start()
    await h.router.submit({ text: 'hello' })
    await vi.waitFor(() => expect(h.router.getSnapshot().requests[0]?.status).toBe('completed'))
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'router.request-updated',
      'router.execution-started',
      'router.execution-finished',
    ]))
    h.router.stop()
    h.sessions.close()
  })
})

function answerDecision(): DelegationDecision {
  return {
    action: 'answer',
    confidence: 0.95,
    complexity: 'low',
    risk: 'none',
    requiredCapabilities: [],
    missingInformation: [],
    rationaleCodes: ['test_answer'],
  }
}

function taskDecision(): DelegationDecision {
  return {
    action: 'task',
    confidence: 0.95,
    complexity: 'medium',
    risk: 'none',
    requiredCapabilities: ['web'],
    missingInformation: [],
    rationaleCodes: ['test_task'],
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
