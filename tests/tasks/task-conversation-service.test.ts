import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskConversationService } from '../../src/main/tasks/task-conversation-service'
import { TaskService } from '../../src/main/tasks/task-service'
import { ThreadService } from '../../src/main/threads/thread-service'

describe('TaskConversationService', () => {
  it('delivers a continued Task message to both the Router thread and Worker Session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-conversation-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const tasks = new TaskService(store.tasks)
    const threads = new ThreadService(store.threads)
    const conversations = new TaskConversationService(tasks, store, threads)
    const session = store.createSession('Weather follow-up')
    const task = tasks.create({
      title: 'Check Nanjing weather',
      origin: 'user',
      sessionId: session.id,
      prompt: 'Check the weather.',
      visiblePrompt: '帮我看看天气',
    })
    tasks.updateStatus(task.id, { status: 'running' })
    tasks.updateStatus(task.id, { status: 'completed' })

    const continued = conversations.continueTask(task.id, '后天什么温度呢', [{
      name: 'forecast.txt',
      path: '/tmp/forecast.txt',
      size: 12,
      kind: 'file',
    }])

    expect(continued).toMatchObject({
      status: 'queued',
      sessionId: session.id,
    })
    expect(continued.prompt).toContain('后天什么温度呢')
    expect(continued.visiblePrompt).toBe('后天什么温度呢')
    expect(store.read(session.id).some((event) => (
      JSON.stringify(event.data).includes('后天什么温度呢')
    ))).toBe(true)
    expect(threads.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'user',
      content: '后天什么温度呢',
      metadata: expect.objectContaining({
        taskId: task.id,
        sessionId: session.id,
        taskMessage: true,
      }),
    })
    store.close()
  })
})
