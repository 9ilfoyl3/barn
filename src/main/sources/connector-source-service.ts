import { createHash } from 'node:crypto'
import type {
  AutomationSettings,
  ConnectorCallInput,
  ConnectorCallResult,
  ConnectorInstance,
  ConnectorSource,
  ConnectorSourceConfig,
  ConnectorSourceEvent,
  ConnectorSourceEventKind,
} from '../../shared/models'
import type { TaskService } from '../tasks/task-service'
import type { ConnectorSourceEventInput, ConnectorSourceStore } from './connector-source-store'

export interface ConnectorReadClient {
  list(): Promise<ConnectorInstance[]>
  callRead(input: ConnectorCallInput): Promise<ConnectorCallResult>
}

export interface ConnectorSourceServiceOptions {
  pollIntervalMs?: number
  maxEventsPerPoll?: number
  now?: () => Date
  getAutomationSettings?: () => AutomationSettings
}

interface CollectedEvent extends ConnectorSourceEventInput {
  taskTitle: string
  taskPrompt: string
}

interface GithubItem {
  number: number
  title: string
  state: string
  author?: string
  labels: string[]
  comments?: number
  htmlUrl: string
  createdAt: string
  updatedAt: string
}

interface DingtalkMessage {
  id: string
  text: string
  sender?: string
  occurredAt: string
}

interface DingtalkTodo {
  id: string
  title: string
  dueAt?: string
  status: string
  occurredAt: string
}

const DEFAULT_SETTINGS: AutomationSettings = {
  mode: 'observe',
  maxPendingSuggestions: 20,
  suggestionCooldownMinutes: 15,
}

/**
 * Collects connector events into a durable source-event pool. The collector is
 * intentionally read-only; proposals and queued tasks are the only outputs.
 */
export class ConnectorSourceService {
  private readonly options: Required<Omit<ConnectorSourceServiceOptions, 'getAutomationSettings'>>
    & Pick<ConnectorSourceServiceOptions, 'getAutomationSettings'>
  private timer: NodeJS.Timeout | undefined
  private running = false
  private started = false

  constructor(
    private readonly store: ConnectorSourceStore,
    private readonly tasks: Pick<TaskService, 'create' | 'list'>,
    private readonly connectors: ConnectorReadClient,
    options: ConnectorSourceServiceOptions = {},
  ) {
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 30_000,
      maxEventsPerPoll: options.maxEventsPerPoll ?? 50,
      now: options.now ?? (() => new Date()),
      ...(options.getAutomationSettings === undefined ? {} : { getAutomationSettings: options.getAutomationSettings }),
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.options.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.poll(false), this.options.pollIntervalMs)
      this.timer.unref()
    }
    void this.poll(false)
  }

  stop(): void {
    this.started = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  list(): ConnectorSource[] {
    return this.store.list()
  }

  listEvents(sourceId?: string, limit?: number): ConnectorSourceEvent[] {
    return this.store.listEvents(sourceId, limit)
  }

  create(input: Parameters<ConnectorSourceStore['create']>[0]): ConnectorSource {
    const source = this.store.create(input)
    queueMicrotask(() => void this.poll(true))
    return source
  }

  setEnabled(sourceId: string, enabled: boolean): ConnectorSource {
    const source = this.store.setEnabled(sourceId, enabled)
    if (enabled) queueMicrotask(() => void this.poll(true))
    return source
  }

  remove(sourceId: string): void {
    this.store.remove(sourceId)
  }

  async pollNow(): Promise<void> {
    await this.poll(true)
  }

  private async poll(force: boolean): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const connectors = await this.connectors.list()
      const now = this.options.now()
      for (const source of this.store.list()) {
        if (!source.enabled) continue
        if (!force && source.lastCheckedAt !== undefined
          && now.getTime() - Date.parse(source.lastCheckedAt) < source.config.pollSeconds * 1_000) continue
        try {
          const connector = connectors.find((item) => item.id === source.config.connectorId)
          if (connector === undefined) throw new Error('The connected app for this source was removed')
          if (connector.kind !== source.config.kind) throw new Error('The source and connector types do not match')
          if (connector.status !== 'ready') throw new Error(`Connector is not ready: ${connector.status}`)
          const events = await this.collect(source, connector)
          this.consume(source, events)
          this.store.saveError(source.id, undefined)
        } catch (error) {
          this.store.saveError(source.id, errorMessage(error))
        }
      }
    } finally {
      this.running = false
    }
  }

  private consume(source: ConnectorSource, collected: CollectedEvent[]): void {
    const settings = this.options.getAutomationSettings?.() ?? DEFAULT_SETTINGS
    const state = this.store.state(source.id)
    const now = this.options.now()
    const events = collected.slice(0, this.options.maxEventsPerPoll)
    const lastEventAt = events.map((event) => event.occurredAt).toSorted().at(-1)
    const cursor = nextCursor(source.config, events, state.cursor)

    if (state.initialized !== true) {
      for (const event of events) this.store.recordEvent(source.id, event)
      this.store.saveState(source.id, { initialized: true, ...(cursor === undefined ? {} : { cursor }), ...(state.lastSuggestionAt === undefined ? {} : { lastSuggestionAt: state.lastSuggestionAt }) })
      this.store.markChecked(source.id, lastEventAt)
      return
    }

    let pendingSuggestions = this.tasks.list().filter((task) => task.status === 'proposed').length
    let lastSuggestionAt = state.lastSuggestionAt === undefined ? 0 : Date.parse(state.lastSuggestionAt)
    let nextLastSuggestion = state.lastSuggestionAt

    for (const event of events) {
      const recorded = this.store.recordEvent(source.id, event)
      if (!recorded.created) continue

      const existing = this.store.openTaskForMatter(event.matterKey)
      if (existing !== undefined) {
        this.store.attachTask(recorded.event.id, existing)
        continue
      }

      if (settings.mode === 'observe' && pendingSuggestions >= settings.maxPendingSuggestions) continue
      if (settings.suggestionCooldownMinutes > 0 && now.getTime() - lastSuggestionAt < settings.suggestionCooldownMinutes * 60_000) continue

      const task = this.tasks.create({
        title: event.taskTitle,
        origin: 'automation',
        status: settings.mode === 'active' ? 'queued' : 'proposed',
        prompt: event.taskPrompt,
        visiblePrompt: taskVisiblePrompt(source, event),
        contract: {
          objective: event.taskPrompt,
          deliverable: 'A concise assessment of whether the user should act, with the next safe step.',
          constraints: ['Use the source evidence and read-only connector calls.', 'Do not change external systems without approval.'],
          inputRefs: event.url === undefined ? [] : [event.url],
          sourceRefs: [event.matterKey, ...(event.url === undefined ? [] : [event.url])],
          acceptanceCriteria: ['States whether the user needs to act.', 'Cites the source event.', 'Proposes a next step without performing an external write.'],
          forbiddenActions: ['Sending messages', 'Creating or modifying external records', 'Deleting data'],
          risk: 'none',
          executionLane: 'background',
          expectedArtifacts: [],
        },
      })
      this.store.attachTask(recorded.event.id, task.id)
      if (settings.mode === 'observe') pendingSuggestions++
      lastSuggestionAt = now.getTime()
      nextLastSuggestion = now.toISOString()
    }

    this.store.saveState(source.id, {
      initialized: true,
      ...(cursor === undefined ? {} : { cursor }),
      ...(nextLastSuggestion === undefined ? {} : { lastSuggestionAt: nextLastSuggestion }),
    })
    this.store.markChecked(source.id, lastEventAt)
  }

  private async collect(source: ConnectorSource, connector: ConnectorInstance): Promise<CollectedEvent[]> {
    if (source.config.kind === 'github') return this.collectGithub(source, connector, source.config)
    return this.collectDingtalk(source, connector, source.config)
  }

  private async collectGithub(
    source: ConnectorSource,
    connector: ConnectorInstance,
    config: Extract<ConnectorSourceConfig, { kind: 'github' }>,
  ): Promise<CollectedEvent[]> {
    const events: CollectedEvent[] = []
    if (config.events.includes('issues')) {
      const value = await this.read(connector, 'github.listIssues', {
        owner: config.owner,
        repo: config.repo,
        state: 'open',
        perPage: 30,
      })
      for (const item of recordsFrom(value, ['issues'])) {
        const issue = githubItem(item)
        if (issue === undefined) continue
        events.push(githubEvent(source, connector, config, issue, false))
      }
    }
    if (config.events.includes('pullRequests')) {
      const value = await this.read(connector, 'github.listPullRequests', {
        owner: config.owner,
        repo: config.repo,
        state: 'open',
        perPage: 30,
      })
      for (const item of recordsFrom(value, ['pullRequests'])) {
        const pull = githubItem(item)
        if (pull === undefined) continue
        events.push(githubEvent(source, connector, config, pull, true))
      }
    }
    return events
  }

  private async collectDingtalk(
    source: ConnectorSource,
    connector: ConnectorInstance,
    config: Extract<ConnectorSourceConfig, { kind: 'dingtalk' }>,
  ): Promise<CollectedEvent[]> {
    const events: CollectedEvent[] = []
    const target = config.conversationId === undefined ? { userId: config.userId! } : { conversationId: config.conversationId }
    if (config.events.includes('messages')) {
      const args = {
        ...target,
        direction: 'newer',
        limit: 50,
        ...(this.store.state(source.id).cursor === undefined ? {} : { time: this.store.state(source.id).cursor }),
      }
      const value = await this.read(connector, 'dingtalk.messageList', args)
      for (const item of recordsFrom(value, ['messages', 'items'])) {
        const message = dingtalkMessage(item)
        if (message === undefined) continue
        if (config.keywords.length > 0 && !config.keywords.some((keyword) => message.text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))) continue
        events.push(dingtalkMessageEvent(connector, config, message, target))
      }
    }
    if (config.events.includes('todos')) {
      const value = await this.read(connector, 'dingtalk.todoList', { page: 1, size: 50 })
      for (const item of recordsFrom(value, ['tasks', 'items'])) {
        const todo = dingtalkTodo(item)
        if (todo === undefined) continue
        events.push(dingtalkTodoEvent(connector, todo))
      }
    }
    return events
  }

  private async read(connector: ConnectorInstance, capability: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.connectors.callRead({ connectorId: connector.id, capability, arguments: args })
    if (result.kind !== 'result') throw new Error(result.message)
    return result.value
  }
}

function githubEvent(
  source: ConnectorSource,
  connector: ConnectorInstance,
  config: Extract<ConnectorSourceConfig, { kind: 'github' }>,
  item: GithubItem,
  pullRequest: boolean,
): CollectedEvent {
  const label = pullRequest ? 'pull request' : 'issue'
  const repository = `${config.owner}/${config.repo}`
  const eventKind: ConnectorSourceEventKind = pullRequest ? 'github_pull_request' : 'github_issue'
  const matterKey = `github:${repository}:${pullRequest ? 'pull' : 'issue'}:${item.number}`
  const summary = [
    `${repository} · ${label} #${item.number}`,
    `State: ${item.state}`,
    `Author: ${item.author ?? 'unknown'}`,
    item.labels.length === 0 ? undefined : `Labels: ${item.labels.join(', ')}`,
    item.comments === undefined ? undefined : `Comments: ${item.comments}`,
    `Updated: ${item.updatedAt}`,
  ].filter((line): line is string => line !== undefined).join('\n')
  return {
    eventKey: `${eventKind}:${item.number}:${item.updatedAt}:${item.state}`,
    matterKey,
    kind: eventKind,
    title: `${titleCase(label)} #${item.number}: ${item.title}`,
    summary,
    url: item.htmlUrl,
    occurredAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    taskTitle: `Review GitHub ${label} #${item.number}: ${truncate(item.title, 120)}`,
    taskPrompt: [
      `Review this GitHub ${label} from ${connector.name}.`,
      '',
      summary,
      item.htmlUrl === undefined ? '' : `URL: ${item.htmlUrl}`,
      '',
      'Decide whether the user needs to act. If they do, analyze the item and give a concise recommendation, draft reply, or implementation plan. Use read-only connector calls for more context. Do not comment, create, modify, or merge anything without approval.',
    ].join('\n'),
  }
}

function dingtalkMessageEvent(
  connector: ConnectorInstance,
  config: Extract<ConnectorSourceConfig, { kind: 'dingtalk' }>,
  message: DingtalkMessage,
  target: Record<string, string>,
): CollectedEvent {
  const targetKey = config.conversationId ?? config.userId ?? 'unknown'
  const summary = [
    `DingTalk · ${connector.name}`,
    message.sender === undefined ? undefined : `From: ${message.sender}`,
    `At: ${message.occurredAt}`,
    '',
    message.text,
  ].filter((line): line is string => line !== undefined).join('\n')
  return {
    eventKey: `dingtalk-message:${targetKey}:${message.id}`,
    matterKey: `dingtalk:${targetKey}:message:${message.id}`,
    kind: 'dingtalk_message',
    title: `DingTalk message${message.sender === undefined ? '' : ` from ${message.sender}`}: ${truncate(message.text, 120)}`,
    summary,
    occurredAt: message.occurredAt,
    taskTitle: `Review DingTalk message: ${truncate(message.text, 120)}`,
    taskPrompt: [
      `Review this DingTalk message from ${connector.name}.`,
      '',
      summary,
      '',
      `Target: ${JSON.stringify(target)}`,
      'Decide whether the user needs to reply or act. If they do, draft the next step clearly. Do not send a message or change DingTalk without approval.',
    ].join('\n'),
  }
}

function dingtalkTodoEvent(
  connector: ConnectorInstance,
  todo: DingtalkTodo,
): CollectedEvent {
  const summary = [
    `DingTalk todo · ${connector.name}`,
    `Status: ${todo.status}`,
    todo.dueAt === undefined ? undefined : `Due: ${todo.dueAt}`,
    `Updated: ${todo.occurredAt}`,
  ].filter((line): line is string => line !== undefined).join('\n')
  return {
    eventKey: `dingtalk-todo:${todo.id}:${todo.status}:${todo.dueAt ?? ''}`,
    matterKey: `dingtalk:todo:${todo.id}`,
    kind: 'dingtalk_todo',
    title: `DingTalk todo: ${truncate(todo.title, 140)}`,
    summary,
    occurredAt: todo.occurredAt,
    taskTitle: `Review DingTalk todo: ${truncate(todo.title, 120)}`,
    taskPrompt: [
      `Review this DingTalk todo from ${connector.name}.`,
      '',
      summary,
      todo.title,
      '',
      'Decide whether the user needs to act before the due time. If they do, prepare a concise next step. Do not change DingTalk without approval.',
    ].join('\n'),
  }
}

function taskVisiblePrompt(source: ConnectorSource, event: CollectedEvent): string {
  const facts = event.summary
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, 6)
    .map((line) => `- ${line}`)
    .join('\n')
  return [
    `${source.name} found something that may need attention.`,
    facts,
    'Barn will assess whether action is needed and keep external changes behind approval.',
  ].filter((part) => part.length > 0).join('\n\n')
}

function githubItem(value: Record<string, unknown>): GithubItem | undefined {
  const number = integer(value.number)
  const title = text(value.title)
  const htmlUrl = text(value.htmlUrl ?? value.html_url)
  const author = text(value.author)
  const comments = integer(value.comments)
  if (number === undefined || title === undefined || htmlUrl === undefined) return undefined
  return {
    number,
    title,
    state: text(value.state) ?? 'open',
    ...(author === undefined ? {} : { author }),
    labels: strings(value.labels),
    ...(comments === undefined ? {} : { comments }),
    htmlUrl,
    createdAt: timeText(value.createdAt ?? value.created_at) ?? new Date().toISOString(),
    updatedAt: timeText(value.updatedAt ?? value.updated_at) ?? new Date().toISOString(),
  }
}

function dingtalkMessage(value: Record<string, unknown>): DingtalkMessage | undefined {
  const body = text(value.text ?? value.content ?? value.body ?? value.message)
  if (body === undefined) return undefined
  const id = text(value.messageId ?? value.msgId ?? value.id ?? value.uuid) ?? hash(JSON.stringify(value))
  const sender = text(value.senderName ?? value.sender ?? value.senderId ?? value.from)
  return {
    id,
    text: body,
    ...(sender === undefined ? {} : { sender }),
    occurredAt: timeText(value.createTime ?? value.createdAt ?? value.time ?? value.sendTime) ?? new Date().toISOString(),
  }
}

function dingtalkTodo(value: Record<string, unknown>): DingtalkTodo | undefined {
  const title = text(value.title ?? value.subject ?? value.name ?? value.content)
  if (title === undefined) return undefined
  const status = text(value.status ?? value.state) ?? (value.completed === true || value.done === true ? 'completed' : 'open')
  if (/completed|done|closed|cancelled/iu.test(status)) return undefined
  const id = text(value.id ?? value.taskId ?? value.todoId) ?? hash(JSON.stringify(value))
  const dueAt = timeText(value.dueTime ?? value.dueAt ?? value.deadline)
  return {
    id,
    title,
    status,
    ...(dueAt === undefined ? {} : { dueAt }),
    occurredAt: timeText(value.updatedAt ?? value.modifiedAt ?? value.createdAt ?? value.dueTime) ?? new Date().toISOString(),
  }
}

function recordsFrom(value: unknown, preferredKeys: readonly string[]): Array<Record<string, unknown>> {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (queue.length > 0) {
    const next = queue.shift()!
    if (Array.isArray(next.value)) return next.value.filter(isRecord)
    if (!isRecord(next.value) || next.depth >= 6) continue
    for (const key of preferredKeys) {
      const candidate = next.value[key]
      if (Array.isArray(candidate)) return candidate.filter(isRecord)
    }
    for (const candidate of Object.values(next.value)) {
      if (Array.isArray(candidate) && candidate.length > 0 && candidate.every(isRecord)) return candidate
      if (isRecord(candidate)) queue.push({ value: candidate, depth: next.depth + 1 })
    }
  }
  return []
}

function nextCursor(config: ConnectorSourceConfig, events: CollectedEvent[], previous: string | undefined): string | undefined {
  if (config.kind !== 'dingtalk') return previous
  return events.map((event) => event.occurredAt).toSorted().at(-1) ?? previous
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function timeText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString()
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
