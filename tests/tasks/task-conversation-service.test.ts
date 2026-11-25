import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TaskRouterDecision, TaskRouterDecisionEngine } from '../../src/main/tasks/task-router-coordinator'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskConversationService } from '../../src/main/tasks/task-conversation-service'
import { TaskService } from '../../src/main/tasks/task-service'

function coordinator(decision: TaskRouterDecision | Error): TaskRouterDecisionEngine {
  return {
    decide: vi.fn(async () => {
      if (decision instanceof Error) throw decision
      return decision
    }),
  }
}

async function harness(decision: TaskRouterDecision | Error, finalStatus: 'running' | 'completed' = 'completed') {
  const directory = await mkdtemp(join(tmpdir(), 'barn-task-conversation-'))
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await store.initialize()
  const tasks = new TaskService(store.tasks)
  const router = coordinator(decision)
  const conversations = new TaskConversationService(tasks, store, router)
  const session = store.createSession('Weather follow-up')
  const task = tasks.create({
    title: 'Check Nanjing weather',
    origin: 'user',
    sessionId: session.id,
    prompt: 'Check the weather.',
    visiblePrompt: '帮我看看天气',
  })
  tasks.updateStatus(task.id, { status: 'running' })
  if (finalStatus === 'completed') tasks.updateStatus(task.id, { status: 'completed' })
  return { store, tasks, session, task, router, conversations }
}

describe('TaskConversationService', () => {
  it('routes an actionable message to only the Worker and stores it once', async () => {
    const h = await harness({
      action: 'delegate',
      confidence: 0.96,
      rationaleCodes: ['worker_owns_execution'],
      memoryRefs: [],
    })
    const continued = await h.conversations.continueTask(h.task.id, '后天什么温度呢', [{
      name: 'forecast.txt',
      path: '/tmp/forecast.txt',
      size: 12,
      kind: 'file',
    }])

    expect(continued).toMatchObject({
      delivery: 'worker',
      task: {
        status: 'queued',
        sessionId: h.session.id,
      },
    })
    expect(continued.task.prompt).toContain('后天什么温度呢')
    expect(continued.task.visiblePrompt).toBe('后天什么温度呢')
    const taskEvents = h.store.read(h.session.id)
    expect(taskEvents.filter((event) => JSON.stringify(event.data).includes('后天什么温度呢'))).toHaveLength(1)
    expect(taskEvents.at(-1)?.data).toMatchObject({
      taskCommand: true,
      taskMessageId: expect.any(String),
    })
    expect(taskEvents.some((event) => event.data && typeof event.data === 'object' && 'actorRole' in event.data && event.data.actorRole === 'router')).toBe(false)
    expect(h.store.threads.listPrimaryMessages()).toHaveLength(0)
    h.store.close()
  })

  it('dispatches an active Task follow-up directly without a Task Router model call', async () => {
    const h = await harness({
      action: 'delegate',
      confidence: 0.5,
      rationaleCodes: ['should_not_run'],
      memoryRefs: [],
    }, 'running')
    const continued = await h.conversations.continueTask(h.task.id, '再补充一个来源')

    expect(continued).toMatchObject({ delivery: 'worker', task: { status: 'queued' } })
    expect(h.router.decide).not.toHaveBeenCalled()
    h.store.close()
  })

  it('cancels an active Task from an explicit stop request without a model call', async () => {
    const h = await harness({
      action: 'delegate',
      confidence: 0.5,
      rationaleCodes: ['should_not_run'],
      memoryRefs: [],
    }, 'running')
    const continued = await h.conversations.continueTask(h.task.id, '停止这个任务')

    expect(continued).toMatchObject({
      delivery: 'router',
      task: { status: 'cancelled' },
    })
    expect(h.router.decide).not.toHaveBeenCalled()
    expect(h.store.read(h.session.id).at(-1)).toMatchObject({
      data: { actorRole: 'router', message: { role: 'assistant' } },
    })
    h.store.close()
  })

  it('lets the Router answer a coordination message without requeueing the Worker', async () => {
    const h = await harness({
      action: 'reply',
      text: '任务已经完成，结果是南京明天 3–13°C，请带外套。',
      confidence: 0.94,
      rationaleCodes: ['status_reply'],
      memoryRefs: [],
    })
    const continued = await h.conversations.continueTask(h.task.id, '现在任务是什么状态？')

    expect(continued.delivery).toBe('router')
    expect(continued.task.status).toBe('completed')
    expect(continued.task.visiblePrompt).toBe('帮我看看天气')
    const events = h.store.read(h.session.id)
    expect(events.filter((event) => event.type === 'agent.message')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      type: 'agent.message',
      actor: { kind: 'agent', id: 'router' },
      data: {
        actorRole: 'router',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '任务已经完成，结果是南京明天 3–13°C，请带外套。' }],
        },
      },
    })
    expect(h.store.threads.listPrimaryMessages()).toHaveLength(0)
    h.store.close()
  })

  it('cancels a Task without starting or continuing a Worker run', async () => {
    const h = await harness({
      action: 'delegate',
      confidence: 0.5,
      rationaleCodes: ['should_not_run'],
      memoryRefs: [],
    }, 'running')
    const continued = await h.conversations.continueTask(h.task.id, '停止这个任务')

    expect(continued).toMatchObject({
      delivery: 'router',
      task: {
        status: 'cancelled',
        detail: 'Cancelled from the Task conversation.',
      },
    })
    expect(h.router.decide).not.toHaveBeenCalled()
    expect(continued.task.visiblePrompt).toBe('帮我看看天气')
    expect(h.store.read(h.session.id).at(-1)).toMatchObject({
      data: {
        actorRole: 'router',
        message: { role: 'assistant' },
      },
    })
    h.store.close()
  })

  it('falls back to the Worker when Task Router coordination fails', async () => {
    const h = await harness(new Error('coordinator unavailable'))
    const continued = await h.conversations.continueTask(h.task.id, '再查一次天气')

    expect(continued).toMatchObject({ delivery: 'worker', task: { status: 'queued' } })
    const events = h.store.read(h.session.id)
    expect(events.some((event) => event.type === 'task.router-fallback')).toBe(true)
    expect(continued.task.prompt).toContain('再查一次天气')
    h.store.close()
  })
})
