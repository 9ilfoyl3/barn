import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { LocalSource, LocalSourceConfig } from '../../shared/models'
import type { TaskService } from '../tasks/task-service'
import { LocalSourceStore, type LocalSourceState } from './local-source-store'

export interface LocalSourceServiceOptions {
  pollIntervalMs?: number
  maxEventsPerPoll?: number
  now?: () => Date
}

interface GeneratedEvent {
  eventKey: string
  title: string
  prompt: string
}

/** Polls deterministic local event sources and turns new events into proposed Tasks. */
export class LocalSourceService {
  private readonly options: Required<LocalSourceServiceOptions>
  private timer: NodeJS.Timeout | undefined
  private running = false
  private started = false

  constructor(
    private readonly store: LocalSourceStore,
    private readonly tasks: Pick<TaskService, 'create' | 'list'>,
    options: LocalSourceServiceOptions = {},
  ) {
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 2_000,
      maxEventsPerPoll: options.maxEventsPerPoll ?? 20,
      now: options.now ?? (() => new Date()),
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.options.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollNow(), this.options.pollIntervalMs)
      this.timer.unref()
    }
    void this.pollNow()
  }

  stop(): void {
    this.started = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  getAutomationSettings(): ReturnType<LocalSourceStore['getAutomationSettings']> {
    return this.store.getAutomationSettings()
  }

  setAutomationSettings(settings: Parameters<LocalSourceStore['setAutomationSettings']>[0]): ReturnType<LocalSourceStore['setAutomationSettings']> {
    return this.store.setAutomationSettings(settings)
  }

  list(): LocalSource[] {
    return this.store.list()
  }

  create(input: Parameters<LocalSourceStore['create']>[0]): LocalSource {
    const source = this.store.create(input)
    if (source.config.kind === 'schedule') {
      this.store.saveState(source.id, {
        nextRunAt: new Date(this.options.now().getTime() + source.config.intervalMinutes * 60_000).toISOString(),
      })
    }
    queueMicrotask(() => void this.pollNow())
    return source
  }

  setEnabled(sourceId: string, enabled: boolean): LocalSource {
    const source = this.store.setEnabled(sourceId, enabled)
    if (enabled) queueMicrotask(() => void this.pollNow())
    return source
  }

  remove(sourceId: string): void {
    this.store.remove(sourceId)
  }

  async pollNow(): Promise<void> {
    if (this.running || !this.started) return
    this.running = true
    try {
      for (const source of this.store.list()) {
        if (!source.enabled) continue
        try {
          const events = source.config.kind === 'file-watch'
            ? await this.scanFiles(source, source.config)
            : this.dueSchedule(source, source.config)
          this.store.saveError(source.id, undefined)
          this.processEvents(source, events)
        } catch (error) {
          this.store.saveError(source.id, errorMessage(error))
        }
      }
    } finally {
      this.running = false
    }
  }

  private processEvents(source: LocalSource, events: GeneratedEvent[]): void {
    const settings = this.store.getAutomationSettings()
    const state = this.store.state(source.id)
    let pendingSuggestions = this.tasks.list().filter((task) => task.status === 'proposed').length
    let lastSuggestionAt = state.lastSuggestionAt === undefined ? 0 : Date.parse(state.lastSuggestionAt)
    for (const event of events.slice(0, this.options.maxEventsPerPoll)) {
      const recorded = this.store.recordEvent(source.id, event)
      if (!recorded.created) continue
      const now = this.options.now()
      if (settings.mode === 'observe' && pendingSuggestions >= settings.maxPendingSuggestions) continue
      if (settings.suggestionCooldownMinutes > 0 && now.getTime() - lastSuggestionAt < settings.suggestionCooldownMinutes * 60_000) continue
      const task = this.tasks.create({
        title: event.title,
        origin: 'automation',
        status: settings.mode === 'active' ? 'queued' : 'proposed',
        prompt: event.prompt,
      })
      this.store.attachTask(recorded.event.id, task.id)
      if (settings.mode === 'observe') pendingSuggestions++
      lastSuggestionAt = now.getTime()
      this.store.saveState(source.id, { ...this.store.state(source.id), lastSuggestionAt: now.toISOString() })
    }
  }

  private async scanFiles(
    source: LocalSource,
    config: Extract<LocalSourceConfig, { kind: 'file-watch' }>,
  ): Promise<GeneratedEvent[]> {
    const root = config.path
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error(`Watched path is not a directory: ${root}`)
    const current: Record<string, string> = {}
    await this.collectFiles(root, config.maxDepth, current)
    const state = this.store.state(source.id)
    const previous = state.files ?? {}
    const initialized = state.initialized === true
    const events: GeneratedEvent[] = []
    if (initialized) {
      for (const [path, signature] of Object.entries(current)) {
        if (previous[path] === signature) continue
        const name = basename(path)
        events.push({
          eventKey: `file:${path}:${signature}`,
          title: `Review changed file: ${name}`,
          prompt: `A watched local file changed: ${path}. Review this change and decide whether any useful office work should be proposed. Do not modify the file without authorization.`,
        })
      }
    }
    this.store.saveState(source.id, { initialized: true, files: current })
    return events
  }

  private async collectFiles(directory: string, depth: number, output: Record<string, string>): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (depth > 0) await this.collectFiles(path, depth - 1, output)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(path)
      output[path] = `${info.size}:${info.mtimeMs}`
    }
  }

  private dueSchedule(
    source: LocalSource,
    config: Extract<LocalSourceConfig, { kind: 'schedule' }>,
  ): GeneratedEvent[] {
    const state = this.store.state(source.id)
    const now = this.options.now()
    const dueAt = state.nextRunAt === undefined ? now : new Date(state.nextRunAt)
    if (dueAt.getTime() > now.getTime()) return []
    const eventKey = `schedule:${dueAt.toISOString()}`
    let next = new Date(dueAt.getTime() + config.intervalMinutes * 60_000)
    while (next.getTime() <= now.getTime()) next = new Date(next.getTime() + config.intervalMinutes * 60_000)
    this.store.saveState(source.id, { nextRunAt: next.toISOString() })
    return [{
      eventKey,
      title: config.title,
      prompt: config.prompt,
    }]
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { LocalSourceState }
