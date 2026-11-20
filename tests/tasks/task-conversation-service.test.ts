import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskConversationService } from '../../src/main/tasks/task-conversation-service'
import { TaskService } from '../../src/main/tasks/task-service'

describe('TaskConversationService', () => {
  it('stores a Task message once in the Task conversation and keeps it out of the Principal Thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-conversation-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const tasks = new TaskService(store.tasks)
    const conversations = new TaskConversationService(tasks, store)
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
    const taskEvents = store.read(session.id)
    expect(taskEvents.filter((event) => (
      JSON.stringify(event.data).includes('后天什么温度呢')
    ))).toHaveLength(1)
    expect(taskEvents.at(-1)?.data).toMatchObject({
      taskCommand: true,
      taskMessageId: expect.any(String),
    })
    expect(store.threads.listPrimaryMessages()).toHaveLength(0)
    store.close()
  })
})
