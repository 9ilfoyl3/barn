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
  it('projects an action, source quote, and executable prompt once and acknowledges it durably', async () => {
    const h = await harness()
    const task = h.tasks.create({
      title: 'Review DingTalk message: deployment failed',
      origin: 'automation',
      presentation: 'routine',
      prompt: 'Fallback watch prompt.',
      visiblePrompt: 'Deployment failed in staging after the Redis migration.',
    })
    const result = {
      outcome: 'completed' as const,
      summary: 'Deployment failed in staging. Check the redis migration before retrying.',
      routine: {
        title: 'Check the Redis migration before retrying deployment',
        prompt: '帮我检查 staging 的 Redis 迁移，并给出重试部署前的修复步骤。',
      },
      artifacts: [],
      evidenceRefs: ['https://example.test/message/1'],
      limitations: [],
      externalEffectReceipts: [],
    }
    const created = h.sessions.routines.record(task, result)
    expect(created).toMatchObject({
      taskId: task.id,
      sourceLabel: 'DingTalk',
      title: 'Check the Redis migration before retrying deployment',
      quote: 'Deployment failed in staging after the Redis migration.',
      prompt: '帮我检查 staging 的 Redis 迁移，并给出重试部署前的修复步骤。',
      outcome: 'completed',
    })
    expect(h.sessions.routines.list()).toHaveLength(1)

    const updated = h.sessions.routines.record(task, {
      ...result,
      routine: {
        title: 'Confirm the deployment recovered',
        prompt: '帮我复核 staging 部署是否已恢复。',
      },
    })
    expect(updated.id).toBe(created.id)
    expect(h.sessions.routines.list()).toMatchObject([{
      id: created.id,
      title: 'Confirm the deployment recovered',
      prompt: '帮我复核 staging 部署是否已恢复。',
    }])

    h.sessions.routines.acknowledge(created.id)
    expect(h.sessions.routines.list()).toHaveLength(0)
    h.sessions.close()
  })

  it('uses readable plain-text actions and quotes for Markdown source messages', async () => {
    const h = await harness()
    const task = h.tasks.create({
      title: 'Review DingTalk message: commit pushed to main',
      origin: 'automation',
      presentation: 'routine',
      prompt: 'Fallback watch prompt.',
      visiblePrompt: '## 群消息\n\n**高飞** [合并请求](https://example.test/mr) 已合并到 `develop`。',
    })
    const notification = h.sessions.routines.record(task, {
      outcome: 'completed',
      summary: 'No failure.',
      routine: {
        title: 'Check the merged template-name fix before release',
        prompt: '帮我复核模板名称修复的发布影响。',
      },
      artifacts: [],
      evidenceRefs: [],
      limitations: [],
      externalEffectReceipts: [],
    })
    expect(notification.title).toBe('Check the merged template-name fix before release')
    expect(notification.quote).toBe('群消息 高飞 合并请求 已合并到 develop。')
    h.sessions.close()
  })
})
