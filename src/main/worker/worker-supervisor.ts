import { randomUUID } from 'node:crypto'
import type {
  HostRequestInput,
  HostToWorkerMessage,
  RunStatus,
  WorkerSessionSeed,
  WorkerToHostMessage,
} from '../../shared/agent-protocol'
import {
  parseWorkerToHostMessage,
} from '../../shared/agent-protocol'

export interface WorkerTransport {
  postMessage(message: HostToWorkerMessage): void
  kill(): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (code: number | null) => void): () => void
}

export type WorkerSupervisorStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'crashed'; error: string; willRestart: boolean }

export interface WorkerSupervisorOptions {
  createTransport(): WorkerTransport
  requestTimeoutMs?: number
  restartDelayMs?: number
  autoRestart?: boolean
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class WorkerSupervisor {
  private transport: WorkerTransport | undefined
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly messageListeners = new Set<(message: WorkerToHostMessage) => void>()
  private readonly statusListeners = new Set<(status: WorkerSupervisorStatus) => void>()
  private readyWaiter: {
    resolve(): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  } | undefined
  private stopping = false
  private status: WorkerSupervisorStatus = { state: 'stopped' }
  private restartTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: WorkerSupervisorOptions) {}

  async start(): Promise<void> {
    if (this.status.state === 'ready') return
    if (this.transport !== undefined) return
    this.stopping = false
    this.setStatus({ state: 'starting' })

    const transport = this.options.createTransport()
    this.transport = transport
    transport.onMessage((message) => this.handleMessage(message))
    transport.onExit((code) => this.handleExit(code))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = undefined
        reject(new Error('Agent Worker did not become ready in time'))
      }, this.options.requestTimeoutMs ?? 10_000)
      this.readyWaiter = { resolve, reject, timer }
    })

    await this.request({ type: 'worker.initialize' })
    this.setStatus({ state: 'ready' })
  }

  async openSession(session: WorkerSessionSeed): Promise<void> {
    await this.request({ type: 'session.open', session })
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.request({ type: 'session.prompt', sessionId, text })
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request({ type: 'session.cancel', sessionId })
  }

  async request(message: HostRequestInput): Promise<unknown> {
    if (this.transport === undefined) throw new Error('Agent Worker is not running')
    const requestId = `host:${randomUUID()}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Agent Worker request timed out: ${message.type}`))
      }, this.options.requestTimeoutMs ?? 30_000)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      try {
        this.transport?.postMessage({ ...message, requestId } as HostToWorkerMessage)
      } catch (error) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        reject(toError(error))
      }
    })
  }

  post(message: HostToWorkerMessage): void {
    if (this.transport === undefined) throw new Error('Agent Worker is not running')
    this.transport.postMessage(message)
  }

  onMessage(listener: (message: WorkerToHostMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onStatus(listener: (status: WorkerSupervisorStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getStatus(): WorkerSupervisorStatus {
    return this.status
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const transport = this.transport
    this.transport = undefined
    this.rejectPending(new Error('Agent Worker stopped'))
    this.rejectReadyWaiter(new Error('Agent Worker stopped'))
    if (transport !== undefined) {
      try {
        transport.postMessage({ type: 'shutdown' })
      } catch {
        // The process may already be gone.
      }
      transport.kill()
    }
    this.setStatus({ state: 'stopped' })
  }

  private handleMessage(value: unknown): void {
    let message: WorkerToHostMessage
    try {
      message = parseWorkerToHostMessage(value)
    } catch (error) {
      this.setStatus({
        state: 'crashed',
        error: `Invalid Agent Worker message: ${toError(error).message}`,
        willRestart: this.shouldAutoRestart(),
      })
      this.transport?.kill()
      return
    }

    if (message.type === 'worker.ready') {
      const waiter = this.readyWaiter
      if (waiter !== undefined) {
        this.readyWaiter = undefined
        clearTimeout(waiter.timer)
        waiter.resolve()
      }
      return
    }

    if (message.type === 'request.ok' || message.type === 'request.error') {
      const pending = this.pendingRequests.get(message.requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pendingRequests.delete(message.requestId)
      if (message.type === 'request.ok') pending.resolve(message.result)
      else pending.reject(new Error(message.error))
      return
    }

    for (const listener of this.messageListeners) listener(message)
  }

  private handleExit(code: number | null): void {
    const transport = this.transport
    this.transport = undefined
    if (transport === undefined) return

    const error = new Error(`Agent Worker exited unexpectedly with code ${code ?? 'unknown'}`)
    this.rejectPending(error)
    this.rejectReadyWaiter(error)

    if (this.stopping) {
      this.setStatus({ state: 'stopped' })
      return
    }

    const willRestart = this.shouldAutoRestart()
    this.setStatus({ state: 'crashed', error: error.message, willRestart })
    if (!willRestart) return

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start().catch((restartError: unknown) => {
        this.setStatus({
          state: 'crashed',
          error: toError(restartError).message,
          willRestart: false,
        })
      })
    }, this.options.restartDelayMs ?? 500)
  }

  private shouldAutoRestart(): boolean {
    return (this.options.autoRestart ?? true) && !this.stopping
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private rejectReadyWaiter(error: Error): void {
    const waiter = this.readyWaiter
    if (waiter === undefined) return
    this.readyWaiter = undefined
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  private setStatus(status: WorkerSupervisorStatus): void {
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export type { RunStatus }
