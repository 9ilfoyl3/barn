import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostToWorkerMessage } from '../../src/shared/agent-protocol'
import type { WorkerTransport } from '../../src/main/worker/worker-supervisor'
import { WorkerSupervisor } from '../../src/main/worker/worker-supervisor'

class FakeTransport implements WorkerTransport {
  readonly sent: HostToWorkerMessage[] = []
  private messageListener: ((message: unknown) => void) | undefined
  private exitListener: ((code: number | null) => void) | undefined

  postMessage(message: HostToWorkerMessage): void {
    this.sent.push(message)
  }

  kill(): void {}

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener
    return () => { this.messageListener = undefined }
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListener = listener
    return () => { this.exitListener = undefined }
  }

  receive(message: unknown): void {
    this.messageListener?.(message)
  }

  exit(code: number | null): void {
    this.exitListener?.(code)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkerSupervisor', () => {
  it('initializes the Worker and correlates requests', async () => {
    const transport = new FakeTransport()
    const supervisor = new WorkerSupervisor({
      createTransport: () => transport,
      autoRestart: false,
    })

    const started = supervisor.start()
    transport.receive({ type: 'worker.ready' })
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const initialize = transport.sent[0]
    expect(initialize?.type).toBe('worker.initialize')
    if (initialize?.type !== 'worker.initialize') throw new Error('missing initialize')
    transport.receive({
      type: 'request.ok',
      requestId: initialize.requestId,
    })
    await started
    expect(supervisor.getStatus().state).toBe('ready')
  })

  it('rejects outstanding requests when the Worker crashes', async () => {
    const transport = new FakeTransport()
    const supervisor = new WorkerSupervisor({
      createTransport: () => transport,
      autoRestart: false,
    })
    const started = supervisor.start()
    transport.receive({ type: 'worker.ready' })
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const initialize = transport.sent[0]
    if (initialize?.type !== 'worker.initialize') throw new Error('missing initialize')
    transport.receive({ type: 'request.ok', requestId: initialize.requestId })
    await started

    const prompt = supervisor.prompt('session-1', 'Hello')
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2))
    transport.exit(1)

    await expect(prompt).rejects.toThrow('exited unexpectedly')
    expect(supervisor.getStatus()).toMatchObject({ state: 'crashed', willRestart: false })
  })

  it('ignores completions for stale request IDs', async () => {
    const transport = new FakeTransport()
    const supervisor = new WorkerSupervisor({
      createTransport: () => transport,
      autoRestart: false,
    })
    const started = supervisor.start()
    transport.receive({ type: 'worker.ready' })
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const initialize = transport.sent[0]
    if (initialize?.type !== 'worker.initialize') throw new Error('missing initialize')
    transport.receive({ type: 'request.ok', requestId: initialize.requestId })
    await started

    const prompt = supervisor.prompt('session-1', 'Hello')
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2))
    transport.receive({ type: 'request.ok', requestId: 'unknown', result: 'ignored' })
    transport.receive({
      type: 'request.ok',
      requestId: transport.sent[1]?.type === 'session.prompt'
        ? transport.sent[1].requestId
        : 'missing',
    })

    await expect(prompt).resolves.toBeUndefined()
  })
})
