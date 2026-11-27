import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AutomationSettings,
  ConnectorCallInput,
  ConnectorCallResult,
  ConnectorInstance,
} from '../../src/shared/models'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { ConnectorSourceService, type ConnectorReadClient } from '../../src/main/sources/connector-source-service'
import { TaskService } from '../../src/main/tasks/task-service'

interface Harness {
  directory: string
  sessions: SessionStore
  tasks: TaskService
  service: ConnectorSourceService
  connector: FakeConnector
}

class FakeConnector implements ConnectorReadClient {
  kind: 'github' | 'dingtalk' = 'github'
  issues: Record<string, unknown>[] = []
  pullRequests: Record<string, unknown>[] = []
  messages: Record<string, unknown>[] = []
  repositories: Record<string, unknown>[] = []
  users: Record<string, unknown>[] = []
  chats: Record<string, unknown>[] = []

  async list(): Promise<ConnectorInstance[]> {
    return [{
      id: 'github-connector',
      kind: this.kind,
      name: this.kind === 'github' ? 'GitHub work' : 'DingTalk work',
      enabled: true,
      configured: true,
      status: 'ready',
      config: {},
      capabilities: [],
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    }]
  }

  async callRead(input: ConnectorCallInput): Promise<ConnectorCallResult> {
    if (input.capability === 'github.listIssues') return { kind: 'result', value: { issues: this.issues } }
    if (input.capability === 'github.listPullRequests') return { kind: 'result', value: { pullRequests: this.pullRequests } }
    if (input.capability === 'github.listRepositories') return { kind: 'result', value: { repositories: this.repositories } }
    if (input.capability === 'dingtalk.chatList') return { kind: 'result', value: { chats: this.chats } }
    if (input.capability === 'dingtalk.chatSearch') return { kind: 'result', value: { messages: this.messages } }
    if (input.capability === 'dingtalk.contactSearch') return { kind: 'result', value: { users: this.users } }
    if (input.capability === 'dingtalk.messageList') return { kind: 'result', value: { messages: this.messages } }
    if (input.capability === 'dingtalk.todoList') return { kind: 'result', value: { tasks: [] } }
    throw new Error(`Unexpected capability: ${input.capability}`)
  }
}

async function harness(settings: AutomationSettings = {
  mode: 'observe',
  maxPendingSuggestions: 20,
  suggestionCooldownMinutes: 0,
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'barn-connector-source-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const connector = new FakeConnector()
  const service = new ConnectorSourceService(sessions.connectorSources, tasks, connector, {
    pollIntervalMs: 0,
    getAutomationSettings: () => settings,
  })
  return { directory, sessions, tasks, service, connector }
}

describe('ConnectorSourceService', () => {
  it('records a baseline, then proposes one task for changed GitHub issues', async () => {
    const h = await harness()
    h.connector.issues = [issue(1, 'Payment retries fail', '2026-11-26T00:00:00.000Z')]
    const source = h.service.create({
      name: 'Payments',
      config: {
        kind: 'github',
        connectorId: 'github-connector',
        owner: 'acme',
        repo: 'payments',
        events: ['issues', 'pullRequests'],
        pollSeconds: 60,
      },
    })
    await h.service.pollNow()
    expect(h.tasks.list()).toHaveLength(0)
    expect(h.sessions.connectorSources.state(source.id)).toMatchObject({ initialized: true })
    expect(h.sessions.connectorSources.listEvents(source.id)).toHaveLength(1)

    h.connector.issues = [issue(1, 'Payment retries fail after upgrade', '2026-11-26T01:00:00.000Z')]
    await h.service.pollNow()
    expect(h.tasks.list()).toMatchObject([{
      status: 'proposed',
      origin: 'automation',
      title: 'Review GitHub acme/payments issue #1: Payment retries fail after upgrade',
    }])
    const task = h.tasks.list()[0]!
    expect(h.sessions.connectorSources.listEvents(source.id)[0]?.taskId).toBe(task.id)
    expect(h.sessions.connectorSources.openTaskForMatter('github:acme/payments:issue:1')).toBe(task.id)

    await h.service.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    expect(h.sessions.connectorSources.listEvents(source.id)).toHaveLength(2)
    h.sessions.close()
  })

  it('reuses an open task when another event changes the same matter', async () => {
    const h = await harness()
    h.connector.issues = [issue(7, 'Review release checklist', '2026-11-26T00:00:00.000Z')]
    const source = h.service.create({
      name: 'Release watch',
      config: {
        kind: 'github',
        connectorId: 'github-connector',
        owner: 'acme',
        repo: 'payments',
        events: ['issues'],
        pollSeconds: 60,
      },
    })
    await h.service.pollNow()
    h.connector.issues = [issue(7, 'Review release checklist', '2026-11-26T01:00:00.000Z')]
    await h.service.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    const task = h.tasks.list()[0]!

    h.connector.issues = [issue(7, 'Review release checklist', '2026-11-26T02:00:00.000Z')]
    await h.service.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    const events = h.sessions.connectorSources.listEvents(source.id)
    expect(events).toHaveLength(3)
    expect(events.filter((event) => event.taskId === task.id).length).toBe(2)
    h.sessions.close()
  })

  it('queues a task in active mode without changing the source contract', async () => {
    const h = await harness({ mode: 'active', maxPendingSuggestions: 20, suggestionCooldownMinutes: 0 })
    h.connector.issues = [issue(3, 'Draft release notes', '2026-11-26T00:00:00.000Z')]
    h.service.create({
      name: 'Release notes',
      config: {
        kind: 'github',
        connectorId: 'github-connector',
        owner: 'acme',
        repo: 'payments',
        events: ['issues'],
        pollSeconds: 60,
      },
    })
    await h.service.pollNow()
    h.connector.issues = [issue(3, 'Draft release notes', '2026-11-26T01:00:00.000Z')]
    await h.service.pollNow()
    expect(h.tasks.list()).toMatchObject([{ status: 'queued', origin: 'automation' }])
    h.sessions.close()
  })

  it('does not create any default watch for DingTalk', async () => {
    const h = await harness()
    h.connector.kind = 'dingtalk'
    expect(await h.service.ensureGithubDefaults()).toHaveLength(0)
    expect(h.service.list()).toHaveLength(0)
    h.sessions.close()
  })

  it('creates one default bound-user GitHub watch and discovers repository activity', async () => {
    const h = await harness()
    h.connector.repositories = [{ fullName: 'acme/payments', owner: 'acme', name: 'payments' }]
    h.connector.issues = [issue(11, 'Default watch issue', '2026-11-26T00:00:00.000Z')]

    const created = await h.service.ensureGithubDefaults()
    expect(created).toHaveLength(1)
    expect(created[0]?.config).toMatchObject({
      kind: 'github',
      connectorId: 'github-connector',
      scope: 'bound-user',
      origin: 'github-default',
      purpose: 'analysis',
    })
    await h.service.pollNow()
    expect(h.sessions.connectorSources.listEvents(created[0]!.id)).toHaveLength(1)
    expect(await h.service.ensureGithubDefaults()).toHaveLength(0)
    expect(h.service.listWatches().filter((source) => source.config.origin === 'github-default')).toHaveLength(1)
    h.sessions.close()
  })

  it('creates a router-managed GitHub watch for a repository and selected authors', async () => {
    const h = await harness()
    const source = await h.service.createWatch({
      provider: 'github',
      target: 'https://github.com/acme/payments',
      actors: ['Octocat'],
      keywords: [],
      purpose: 'analysis',
      instruction: 'Watch payment regressions and tell me if a release is blocked.',
    })
    expect(source).toMatchObject({
      name: 'GitHub · acme/payments',
      config: {
        kind: 'github',
        scope: 'repository',
        owner: 'acme',
        repo: 'payments',
        actors: ['octocat'],
        origin: 'router',
        purpose: 'analysis',
        instruction: 'Watch payment regressions and tell me if a release is blocked.',
      },
    })
    expect(h.service.listWatches().some((watch) => watch.id === source.id)).toBe(true)
    expect(h.service.cancelWatch('acme/payments').id).toBe(source.id)
    expect(h.service.listWatches().some((watch) => watch.id === source.id)).toBe(false)
    h.sessions.close()
  })

  it('resolves a DingTalk conversation name and creates a reply watch with the user instruction', async () => {
    const h = await harness()
    h.connector.kind = 'dingtalk'
    h.connector.chats = [{ name: '上线项目群', openConversationId: 'cid_launch' }]
    h.connector.messages = [{
      ...dingtalkMessage('m1', '上线项目需要确认'),
      conversationId: 'cid_launch',
    }]
    h.connector.messages = [h.connector.messages[0]!]
    h.connector.kind = 'dingtalk'
    const source = await h.service.createWatch({
      provider: 'dingtalk',
      target: '上线项目群',
      actors: [],
      keywords: ['上线', '审批'],
      purpose: 'reply',
      instruction: '看到上线审批相关消息时帮我拟一条回复。',
    })
    expect(source.config).toMatchObject({
      kind: 'dingtalk',
      conversationId: 'cid_launch',
      targetLabel: '上线项目群',
      keywords: ['上线', '审批'],
      purpose: 'reply',
      instruction: '看到上线审批相关消息时帮我拟一条回复。',
    })

    await h.service.pollNow()
    h.connector.messages = [
      h.connector.messages[0]!,
      { ...dingtalkMessage('m2', '上线审批还差你确认', '2026-11-26T01:00:00.000Z'), conversationId: 'cid_launch' },
    ]
    await h.service.pollNow()
    expect(h.tasks.list()).toMatchObject([{
      status: 'queued',
      title: 'Review DingTalk message: 上线审批还差你确认',
    }])
    expect(h.tasks.list()[0]?.prompt).toContain('Watch instruction: 看到上线审批相关消息时帮我拟一条回复。')
    expect(h.tasks.list()[0]?.prompt).toContain('approval-backed external-write path')
    h.sessions.close()
  })

  it('proposes a DingTalk message only after the baseline and keyword filter', async () => {
    const h = await harness()
    h.connector.kind = 'dingtalk'
    h.connector.messages = [dingtalkMessage('m1', '今天上线时间确认一下')]
    const source = h.service.create({
      name: 'Launch group',
      config: {
        kind: 'dingtalk',
        connectorId: 'github-connector',
        conversationId: 'cid_launch',
        keywords: ['上线'],
        events: ['messages', 'todos'],
        pollSeconds: 180,
      },
    })
    await h.service.pollNow()
    expect(h.tasks.list()).toHaveLength(0)
    expect(h.sessions.connectorSources.state(source.id).cursor).toBe('2026-11-26T00:00:00.000Z')

    h.connector.messages = [
      dingtalkMessage('m1', '今天上线时间确认一下'),
      dingtalkMessage('m2', '上线审批还差你确认', '2026-11-26T01:00:00.000Z'),
      dingtalkMessage('m3', '午饭吃什么', '2026-11-26T02:00:00.000Z'),
    ]
    await h.service.pollNow()
    expect(h.tasks.list()).toMatchObject([{
      status: 'proposed',
      title: 'Review DingTalk message: 上线审批还差你确认',
    }])
    expect(h.sessions.connectorSources.listEvents(source.id)).toHaveLength(2)
    h.sessions.close()
  })
})

function issue(number: number, title: string, updatedAt: string): Record<string, unknown> {
  return {
    number,
    title,
    state: 'open',
    author: 'octocat',
    labels: ['bug'],
    comments: 2,
    htmlUrl: `https://github.com/acme/payments/issues/${number}`,
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt,
  }
}

function dingtalkMessage(id: string, text: string, occurredAt = '2026-11-26T00:00:00.000Z'): Record<string, unknown> {
  return {
    messageId: id,
    text,
    senderName: 'Alice',
    createTime: occurredAt,
  }
}
