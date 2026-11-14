import type { PermissionService } from '../permissions/permission-service'
import { ActionStore } from './action-store'
import type {
  ActionHandler,
  ActionRecord,
  ActionRequestInput,
  ActionStatus,
} from './types'

export interface ActionServiceOptions {
  pollIntervalMs?: number
  actionTimeoutMs?: number
  now?: () => Date
  autoRun?: boolean
}

/** Durable outbox for consequential actions: permission gate, idempotent execution, retries, and audit. */
export class ActionService {
  private readonly handlers = new Map<string, ActionHandler>()
  private readonly options: Required<ActionServiceOptions>
  private disposers: Array<() => void> = []
  private timer: NodeJS.Timeout | undefined
  private running = false
  private started = false
  private readonly abort = new AbortController()

  constructor(
    private readonly store: ActionStore,
    private readonly permissions: Pick<PermissionService, 'request' | 'onResolved'>,
    options: ActionServiceOptions = {},
  ) {
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 1_000,
      actionTimeoutMs: options.actionTimeoutMs ?? 120_000,
      now: options.now ?? (() => new Date()),
      autoRun: options.autoRun ?? true,
    }
  }

  registerHandler(handler: ActionHandler): void {
    if (this.handlers.has(handler.kind)) throw new Error(`Action handler already registered: ${handler.kind}`)
    this.handlers.set(handler.kind, handler)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.store.recoverRunning(this.now())
    this.disposers.push(this.permissions.onResolved(({ approval, decision }) => {
      const action = this.store.findByApprovalId(approval.id)
      if (action === undefined) return
      if (decision === 'approved') {
        if (action.status === 'pending_approval') this.store.queueAfterApproval(action.id, this.now())
        this.schedule()
      } else if (action.status === 'pending_approval') {
        this.store.cancel(action.id, 'Denied by a person.', this.now())
      }
    }))
    if (this.options.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.runDue(), this.options.pollIntervalMs)
      this.timer.unref()
    }
    this.schedule()
  }

  stop(): void {
    this.started = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.abort.abort()
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  enqueue(input: ActionRequestInput): ActionRecord {
    const existing = this.store.findByIdempotencyKey(input.idempotencyKey)
    if (existing !== undefined) return existing
    const permission = this.permissions.request({
      kind: input.permissionKind,
      title: input.title,
      summary: input.summary,
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    })
    if (permission.decision === 'denied') {
      const action = this.store.create(input, 'queued')
      return this.store.cancel(action.id, permission.reason, this.now())
    }
    if (permission.decision === 'approval_required') {
      return this.store.create(input, 'pending_approval', permission.approval.id)
    }
    const action = this.store.create(input, 'queued')
    this.schedule()
    return action
  }

  get(actionId: string): ActionRecord {
    return this.store.get(actionId)
  }

  list(): ActionRecord[] {
    return this.store.list()
  }

  events(actionId: string): ReturnType<ActionStore['events']> {
    return this.store.events(actionId)
  }

  retry(actionId: string): ActionRecord {
    const action = this.store.retry(actionId, this.now())
    this.schedule()
    return action
  }

  cancel(actionId: string, reason = 'Cancelled by a person.'): ActionRecord {
    return this.store.cancel(actionId, reason, this.now())
  }

  /** Execute every action that is due now. The timer calls this, and tests can drive it deterministically. */
  async runDue(): Promise<void> {
    if (this.running || !this.started) return
    this.running = true
    try {
      for (;;) {
        const due = this.store.due(this.now())[0]
        if (due === undefined) return
        const claimed = this.store.claim(due.id, this.now())
        if (claimed === undefined) continue
        await this.execute(claimed)
      }
    } finally {
      this.running = false
      if (this.store.due(this.now()).length > 0) this.schedule()
    }
  }

  private async execute(action: ActionRecord): Promise<void> {
    const handler = this.handlers.get(action.kind)
    if (handler === undefined) {
      this.fail(action, new Error(`No handler registered for action kind: ${action.kind}`))
      return
    }
    try {
      const timeoutController = new AbortController()
      const timer = setTimeout(() => timeoutController.abort(), this.options.actionTimeoutMs)
      timer.unref?.()
      const signal = AbortSignal.any([this.abort.signal, timeoutController.signal])
      try {
        const result = await Promise.race([
          handler.execute(action, {
            actionId: action.id,
            idempotencyKey: action.idempotencyKey,
            signal,
          }),
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Action execution was aborted')), { once: true })
          }),
        ])
        this.store.succeed(action.id, result, this.now())
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      this.fail(action, error)
    }
  }

  private fail(action: ActionRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const retryAt = action.attempts >= action.maxAttempts
      ? undefined
      : new Date(this.options.now().getTime() + retryDelay(action.attempts)).toISOString()
    this.store.fail(action.id, message, retryAt, this.now())
  }

  private schedule(): void {
    if (!this.started || !this.options.autoRun) return
    queueMicrotask(() => void this.runDue())
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}

function retryDelay(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1))
}

export type { ActionStatus }
