import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { ModelStreamBroker, type ModelStreamSource } from '../../src/main/models/model-stream-broker'
import type { HostToWorkerMessage, WorkerToHostMessage } from '../../src/shared/agent-protocol'

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
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
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function startMessage(options: Record<string, unknown> = {}): Extract<WorkerToHostMessage, { type: 'model.start' }> {
  return {
    type: 'model.start',
    requestId: 'worker:model:1',
    sessionId: 'session-1',
    selection: { providerId: 'openai', modelId: 'test-model' },
    context: { messages: [] },
    options,
  }
}

describe('ModelStreamBroker', () => {
  it('forwards provider events in order and returns the terminal message', async () => {
    const stream = createAssistantMessageEventStream()
    const models: ModelStreamSource = {
      streamSimple: vi.fn(() => {
        stream.push({ type: 'start', partial: assistantMessage('') })
        stream.push({
          type: 'text_start',
          contentIndex: 0,
          partial: assistantMessage(''),
        })
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Hello',
          partial: assistantMessage('Hello'),
        })
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: 'Hello',
          partial: assistantMessage('Hello'),
        })
        stream.push({ type: 'done', reason: 'stop', message: assistantMessage('Hello') })
        return stream
      }),
    }
    const posted: HostToWorkerMessage[] = []
    const broker = new ModelStreamBroker(models, (message) => posted.push(message))

    broker.start(startMessage())
    await vi.waitFor(() => {
      expect(posted.some((message) => message.type === 'model.event' && eventType(message.event) === 'done')).toBe(true)
    })

    expect(posted.map((message) => message.type === 'model.event' ? eventType(message.event) : message.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ])
  })

  it('aborts the provider stream when the Worker cancels', async () => {
    let signal: AbortSignal | undefined
    const stream = createAssistantMessageEventStream()
    const models: ModelStreamSource = {
      streamSimple: (_selection, _context, options) => {
        signal = options?.signal
        return stream
      },
    }
    const broker = new ModelStreamBroker(models, () => undefined)

    broker.start(startMessage())
    broker.abort('worker:model:1')

    expect(signal?.aborted).toBe(true)
  })

  it('does not forward provider events after cancellation', async () => {
    const stream = createAssistantMessageEventStream()
    const models: ModelStreamSource = {
      streamSimple: () => stream,
    }
    const posted: HostToWorkerMessage[] = []
    const broker = new ModelStreamBroker(models, (message) => posted.push(message))

    broker.start(startMessage())
    broker.abort('worker:model:1')
    stream.push({ type: 'error', reason: 'aborted', error: assistantMessage('') })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(posted).toEqual([])
  })
})

function eventType(event: unknown): string {
  return typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string'
    ? event.type
    : 'unknown'
}
