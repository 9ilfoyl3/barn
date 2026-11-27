import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-routine-store-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  return { sessions, tasks }
}

describe('RoutineStore', () => {
  it('projects a routine Task result once and acknowledges it durably', async () => {
    const h = await harness()
    const task = h.tasks.create({
      title: 'Review DingTalk message: deployment failed',
      origin: 'automation',
      presentation: 'routine',
      prompt: 'Analyze the deployment message.',
    })
    const result = {
      outcome: 'completed' as const,
      summary: 'Deployment failed in staging. Check the redis migration before retrying.',
      artifacts: [],
      evidenceRefs: ['https://example.test/message/1'],
      limitations: [],
      externalEffectReceipts: [],
    }
    const created = h.sessions.routines.record(task, result)
    expect(created).toMatchObject({
      taskId: task.id,
      sourceLabel: 'DingTalk',
      title: task.title,
      body: result.summary,
      outcome: 'completed',
    })
    expect(h.sessions.routines.list()).toHaveLength(1)

    const updated = h.sessions.routines.record(task, {
      ...result,
      summary: 'Deployment recovered after the Redis migration was rolled back.',
    })
    expect(updated.id).toBe(created.id)
    expect(h.sessions.routines.list()).toMatchObject([{
      id: created.id,
      body: 'Deployment recovered after the Redis migration was rolled back.',
    }])

    h.sessions.routines.acknowledge(created.id)
    expect(h.sessions.routines.list()).toHaveLength(0)
    h.sessions.close()
  })

  it('uses readable plain-text previews for Markdown watch results', async () => {
    const h = await harness()
    const task = h.tasks.create({
      title: 'Review DingTalk message: #### [commit](https://example.test/c) pushed to main',
      origin: 'automation',
      presentation: 'routine',
      prompt: 'Analyze the message.',
    })
    const notification = h.sessions.routines.record(task, {
      outcome: 'completed',
      summary: '## Summary\n\n**No failure.** See [details](https://example.test/mr).',
      artifacts: [],
      evidenceRefs: [],
      limitations: [],
      externalEffectReceipts: [],
    })
    expect(notification.title).toBe('Review DingTalk message: commit pushed to main')
    expect(notification.body).toBe('Summary No failure. See details.')
    h.sessions.close()
  })
})
