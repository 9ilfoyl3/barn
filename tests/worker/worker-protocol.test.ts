import { describe, expect, it } from 'vitest'
import {
  parseHostToWorkerMessage,
  parseWorkerToHostMessage,
} from '../../src/shared/agent-protocol'

describe('worker protocol', () => {
  it('rejects malformed external messages', () => {
    expect(() => parseWorkerToHostMessage({
      type: 'model.start',
      requestId: '',
      sessionId: 'session-1',
    })).toThrow()
    expect(() => parseHostToWorkerMessage({
      type: 'session.prompt',
      requestId: 'request-1',
      sessionId: 'session-1',
      text: '',
    })).toThrow()
  })

  it('keeps model payloads opaque but validates the envelope', () => {
    const parsed = parseWorkerToHostMessage({
      type: 'model.start',
      requestId: 'worker:model:1',
      sessionId: 'session-1',
      selection: { providerId: 'openai', modelId: 'gpt-5' },
      context: { messages: [{ role: 'user', content: 'hello' }] },
      options: { temperature: 0.2 },
    })

    if (parsed.type !== 'model.start') throw new Error('expected model.start')
    expect(parsed.context).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('accepts assistant deltas without allowing unknown UI event types', () => {
    expect(parseWorkerToHostMessage({
      type: 'session.event',
      sessionId: 'session-1',
      runId: 'run-1',
      event: { type: 'assistant.delta', delta: 'Hello' },
    })).toMatchObject({ event: { type: 'assistant.delta' } })

    expect(parseWorkerToHostMessage({
      type: 'session.event',
      sessionId: 'session-1',
      runId: 'run-1',
      event: {
        type: 'tool.started',
        toolCallId: 'call-1',
        toolName: 'shell',
        arguments: '{"command":"pwd"}',
      },
    })).toMatchObject({
      event: { type: 'tool.started', arguments: '{"command":"pwd"}' },
    })

    expect(() => parseWorkerToHostMessage({
      type: 'session.event',
      sessionId: 'session-1',
      runId: 'run-1',
      event: { type: 'raw-provider-event', data: {} },
    })).toThrow()
  })
})
