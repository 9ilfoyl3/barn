import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { ContextManager } from '../../src/worker/context-manager'

describe('ContextManager', () => {
  it('keeps small conversations unchanged', () => {
    const manager = new ContextManager({ contextWindow: 128_000, maxOutputTokens: 8_000 })
    const messages: AgentMessage[] = [
      system('system prompt'),
      user('hello'),
      assistant([{ type: 'text', text: 'hi' }]),
    ]

    const result = manager.transform(messages)
    expect(result.messages).toEqual(messages)
    expect(result.compacted).toBe(false)
    expect(result.tokens).toBeLessThan(result.budget)
  })

  it('keeps key excerpts and exact sequence refs in the checkpoint', () => {
    const manager = new ContextManager({ contextWindow: 3_000, maxOutputTokens: 500 })
    const messages: AgentMessage[] = [system('system prompt')]
    let seq = 1
    for (let index = 0; index < 10; index++) {
      messages.push(sequenced(user(`request ${index}: preserve this requirement`), seq++))
      messages.push(sequenced(assistant([{ type: 'text', text: `answer ${index}: decision ${index}` }]), seq++))
      messages.push(sequenced({
        role: 'toolResult',
        toolCallId: `call-${index}`,
        toolName: 'read_file',
        content: [{ type: 'text', text: index === 1 ? 'ERROR: permission denied for the source file' : `result ${index}` }],
        isError: index === 1,
        timestamp: Date.now(),
      }, seq++))
    }
    messages.push(sequenced(user('latest request'), seq))

    const result = manager.transform(messages)
    const checkpoint = result.messages.find((message) => (
      message.role === 'system' && String(message.content).includes('[Barn context checkpoint]')
    ))
    expect(checkpoint).toBeDefined()
    expect(String(checkpoint?.content)).toContain('Exact transcript range: seq 1-')
    expect(String(checkpoint?.content)).toContain('session_history')
    expect(String(checkpoint?.content)).toContain('Earlier user requests')
    expect(String(checkpoint?.content)).toContain('Earlier tool issues')
    expect(String(checkpoint?.content)).toContain('permission denied')
  })

  it('compacts older turns while preserving the latest request and tool result', () => {
    const manager = new ContextManager({ contextWindow: 3_000, maxOutputTokens: 500 })
    const messages: AgentMessage[] = [system('system prompt')]
    for (let index = 0; index < 12; index++) {
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: `call-${index}`,
        name: 'read_file',
        arguments: { path: `/tmp/file-${index}.txt` },
      }
      messages.push(user(`request ${index}`))
      messages.push(assistant([toolCall]))
      messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: `large result ${index} `.repeat(500) }],
        isError: false,
        timestamp: Date.now(),
      })
      messages.push(assistant([{ type: 'text', text: `answer ${index} `.repeat(80) }]))
    }

    const result = manager.transform(messages)
    expect(result.compacted).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(result.budget)
    expect(result.messages[0]).toMatchObject({ role: 'system', content: 'system prompt' })
    expect(result.messages.some((message) => message.role === 'system' && String(message.content).includes('context checkpoint'))).toBe(true)
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(result.messages.some((message) => message.role === 'user' && String(message.content).includes('request 11'))).toBe(true)

    const toolCalls = result.messages.flatMap((message) => message.role === 'assistant'
      ? message.content.filter((block) => block.type === 'toolCall').map((block) => block.id)
      : [])
    const toolResults = result.messages.flatMap((message) => message.role === 'toolResult' ? [message.toolCallId] : [])
    expect(toolResults).toEqual(toolCalls)
  })
})

function sequenced(message: AgentMessage, seq: number): AgentMessage {
  return { ...message, barnSeq: seq } as unknown as AgentMessage
}

function system(content: string): AgentMessage {
  return { role: 'system', content, timestamp: Date.now() }
}

function user(content: string): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() }
}

function assistant(content: AssistantMessage['content']): AgentMessage {
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
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}
