import type { AssistantMessage, AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import type {
  HostToWorkerMessage,
  ToolExecutionResult,
  WorkerToHostMessage,
} from '../../src/shared/agent-protocol'
import type { WorkerPort } from '../../src/worker/worker-runtime'
import { WorkerRuntime } from '../../src/worker/worker-runtime'

class FakeHost implements WorkerPort {
  readonly received: WorkerToHostMessage[] = []
  private listener: ((message: unknown) => void) | undefined
  private modelCount = 0

  constructor(private readonly strategy: 'text' | 'tools' | 'hanging-tool' = 'text') {}

  postMessage(message: WorkerToHostMessage): void {
    this.received.push(message)
    if (message.type === 'session.append') {
      this.send({
        type: 'request.ok',
        requestId: message.requestId,
        result: true,
      })
    } else if (message.type === 'tool.execute') {
      if (this.strategy === 'hanging-tool') return
      this.send({
        type: 'request.ok',
        requestId: message.requestId,
        result: {
          content: [{ type: 'text', text: 'file contents' }],
          details: { path: 'roster.xlsx' },
        } satisfies ToolExecutionResult,
      })
    } else if (message.type === 'model.start') {
      void this.respondToModel(message.requestId)
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }

  send(message: HostToWorkerMessage): void {
    this.listener?.(message)
  }

  waitFor<T extends WorkerToHostMessage['type']>(type: T): Extract<WorkerToHostMessage, { type: T }> {
    const message = this.received.find((entry) => entry.type === type)
    if (message === undefined) throw new Error(`missing ${type}`)
    return message as Extract<WorkerToHostMessage, { type: T }>
  }

  private async respondToModel(requestId: string): Promise<void> {
    this.modelCount++
    if (this.strategy === 'text' || (this.strategy === 'tools' && this.modelCount === 2)) {
      const partial = assistant([{ type: 'text', text: 'I will inspect it.' }], 'pending')
      this.emitModelEvents(requestId, [
        { type: 'start', partial: assistant([], 'pending') },
        { type: 'text_start', contentIndex: 0, partial: assistant([], 'pending') },
        { type: 'text_delta', contentIndex: 0, delta: 'I will inspect it.', partial },
        { type: 'text_end', contentIndex: 0, content: 'I will inspect it.', partial },
        { type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: 'Done.' }], 'stop') },
      ])
      return
    }
    if (this.modelCount === 1) {
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: 'call-1',
        name: 'list_dir',
        arguments: { path: '.' },
      }
      const partial = assistant([toolCall], 'pending')
      this.emitModelEvents(requestId, [
        { type: 'start', partial },
        { type: 'done', reason: 'toolUse', message: { ...partial, stopReason: 'toolUse' } },
      ])
      return
    }
    if (this.strategy === 'hanging-tool') return
    this.emitModelEvents(requestId, [
      { type: 'start', partial: assistant([], 'pending') },
      { type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: 'Done.' }], 'stop') },
    ])
  }

  private emitModelEvents(requestId: string, events: AssistantMessageEvent[]): void {
    for (const event of events) this.send({ type: 'model.event', requestId, event })
  }
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  }
}

const model = {
  id: 'test-model',
  name: 'Test Model',
  providerId: 'openai',
  api: 'openai-responses',
  reasoning: false,
  reasoningEfforts: [],
  contextWindow: 128_000,
  maxTokens: 8_000,
  input: ['text' as const],
}

async function initialize(host: FakeHost, runtime: WorkerRuntime): Promise<void> {
  runtime.start()
  await viWait(() => host.received.some((message) => message.type === 'worker.ready'))
  host.send({ type: 'worker.initialize', requestId: 'host:init' })
  await viWait(() => host.received.some((message) => message.type === 'request.ok' && message.requestId === 'host:init'))
  host.send({
    type: 'session.open',
    requestId: 'host:open',
    session: { sessionId: 'session-1', messages: [], model },
  })
  await viWait(() => host.received.some((message) => message.type === 'request.ok' && message.requestId === 'host:open'))
}

async function viWait(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition not met')
}

describe('WorkerRuntime', () => {
  it('correlates malformed host requests with the original request ID', async () => {
    const host = new FakeHost()
    const runtime = new WorkerRuntime(host)
    runtime.start()

    host.send({
      type: 'session.prompt',
      requestId: 'host:malformed-prompt',
      sessionId: 'session-1',
      text: '',
    })

    await viWait(() => host.received.some(
      (message) => message.type === 'request.error' && message.requestId === 'host:malformed-prompt',
    ))
    expect(host.received.find(
      (message) => message.type === 'request.error' && message.requestId === 'host:malformed-prompt',
    )).toMatchObject({ type: 'request.error' })
  })

  it('runs a multi-turn prompt and persists complete messages', async () => {
    const host = new FakeHost()
    const runtime = new WorkerRuntime(host)
    await initialize(host, runtime)

    const before = host.received.length
    host.send({
      type: 'session.prompt',
      requestId: 'host:prompt',
      sessionId: 'session-1',
      text: 'Hello',
    })

    await viWait(() => host.received.slice(before).some(
      (message) => message.type === 'run.status' && message.status === 'idle',
    ))
    const appended = host.received.filter((message) => message.type === 'session.append')
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ message: { role: 'assistant' } })
    expect(host.received.some((message) => message.type === 'session.event' && message.event.type === 'assistant.delta'))
      .toBe(true)
  })

  it('exposes bounded search and discovery tools to the model', async () => {
    const host = new FakeHost()
    const runtime = new WorkerRuntime(host)
    await initialize(host, runtime)

    const before = host.received.length
    host.send({
      type: 'session.prompt',
      requestId: 'host:prompt-tool-schema',
      sessionId: 'session-1',
      text: 'Search the workspace',
    })
    await viWait(() => host.received.slice(before).some(
      (message) => message.type === 'run.status' && message.status === 'idle',
    ))

    const start = host.received.find((message) => message.type === 'model.start')
    const serializedContext = JSON.stringify(start?.context)
    expect(serializedContext).toEqual(expect.stringContaining('find_files'))
    expect(serializedContext).toEqual(expect.stringContaining('search_files'))
    expect(serializedContext).toEqual(expect.stringContaining('literal'))
    expect(serializedContext).toEqual(expect.stringContaining('maxEntries'))
    expect(serializedContext).toEqual(expect.stringContaining('write_file'))
    expect(serializedContext).toEqual(expect.stringContaining('edit_file'))
    expect(serializedContext).toEqual(expect.stringContaining('memory_search'))
    expect(serializedContext).toEqual(expect.stringContaining('memory_save'))
  })

  it('executes file tools through the Host and continues the model loop', async () => {
    const host = new FakeHost('tools')
    const runtime = new WorkerRuntime(host)
    await initialize(host, runtime)

    const before = host.received.length
    host.send({
      type: 'session.prompt',
      requestId: 'host:prompt-tools',
      sessionId: 'session-1',
      text: 'Inspect the roster',
    })

    await viWait(() => host.received.slice(before).some(
      (message) => message.type === 'run.status' && message.status === 'idle',
    ))
    const toolCall = host.received.find((message) => message.type === 'tool.execute')
    expect(toolCall).toMatchObject({
      toolName: 'list_dir',
      args: { path: '.' },
    })
    const started = host.received.find(
      (message) => message.type === 'session.event' && message.event.type === 'tool.started',
    )
    expect(started).toMatchObject({
      event: {
        type: 'tool.started',
        toolName: 'list_dir',
        arguments: '{"path":"."}',
      },
    })
  })

  it('cancels an in-flight Host tool without waiting for it to finish', async () => {
    const host = new FakeHost('hanging-tool')
    const runtime = new WorkerRuntime(host)
    await initialize(host, runtime)

    const before = host.received.length
    host.send({
      type: 'session.prompt',
      requestId: 'host:prompt-cancel-tool',
      sessionId: 'session-1',
      text: 'Run a long command',
    })

    await viWait(() => host.received.some((message) => message.type === 'tool.execute'))
    const toolRequest = host.waitFor('tool.execute')
    host.send({ type: 'session.cancel', requestId: 'host:cancel-tool', sessionId: 'session-1' })

    await viWait(() => host.received.slice(before).some(
      (message) => message.type === 'run.status' && message.status === 'cancelled',
    ))
    expect(host.received.find((message) => message.type === 'tool.cancel')).toMatchObject({
      requestId: toolRequest.requestId,
    })
  })
})
