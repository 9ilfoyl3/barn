import { createAssistantMessageEventStream, type AssistantMessage, type Context, type SimpleStreamOptions, type ToolCall } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, VisibleMessage } from '../../src/shared/models'
import type { ModelService } from '../../src/main/models/model-service'
import { ModelRouterDecisionEngine, type RouterConnectorGateway } from '../../src/main/router/router-decision'
import { EMAIL_CONNECTOR } from '../../src/main/connectors/catalog'

function fakeModel(response: string): ModelService {
  const selection: ModelSelection = { providerId: 'openai', modelId: 'router-model' }
  return {
    getSnapshot: async () => ({
      providers: [],
      defaultModel: selection,
      defaultReasoningEffort: 'max',
      modelSettingsVersion: 1,
    }),
    getModelDescriptor: () => ({
      id: 'router-model',
      name: 'Router Model',
      providerId: 'openai',
      api: 'openai-responses',
      reasoning: true,
      reasoningEfforts: ['high', 'max'],
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ['text'],
    }),
    streamSimple: (_selection: ModelSelection, _context: Context, _options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream()
      const partial = assistant('')
      stream.push({ type: 'start', partial })
      stream.push({ type: 'text_start', contentIndex: 0, partial })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: response, partial: assistant(response) })
      stream.push({ type: 'text_end', contentIndex: 0, content: response, partial: assistant(response) })
      stream.push({ type: 'done', reason: 'stop', message: assistant(response) })
      return stream
    },
  } as unknown as ModelService
}

function fakeSequencedModel(responses: string[]): ModelService {
  const selection: ModelSelection = { providerId: 'openai', modelId: 'router-model' }
  let index = 0
  return {
    getSnapshot: async () => ({
      providers: [],
      defaultModel: selection,
      defaultReasoningEffort: 'max',
      modelSettingsVersion: 1,
    }),
    getModelDescriptor: () => ({
      id: 'router-model',
      name: 'Router Model',
      providerId: 'openai',
      api: 'openai-responses',
      reasoning: true,
      reasoningEfforts: ['high', 'max'],
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ['text'],
    }),
    streamSimple: () => {
      const response = responses[index++] ?? responses.at(-1) ?? ''
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'start', partial: assistant('') })
      stream.push({ type: 'text_start', contentIndex: 0, partial: assistant('') })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: response, partial: assistant(response) })
      stream.push({ type: 'text_end', contentIndex: 0, content: response, partial: assistant(response) })
      stream.push({ type: 'done', reason: 'stop', message: assistant(response) })
      return stream
    },
  } as unknown as ModelService
}

function fakeModelWithToolCall(args: ToolCall['arguments']): ModelService {
  const selection: ModelSelection = { providerId: 'openai', modelId: 'router-model' }
  return {
    getSnapshot: async () => ({
      providers: [],
      defaultModel: selection,
      defaultReasoningEffort: 'max',
      modelSettingsVersion: 1,
    }),
    getModelDescriptor: () => ({
      id: 'router-model',
      name: 'Router Model',
      providerId: 'openai',
      api: 'openai-responses',
      reasoning: true,
      reasoningEfforts: ['high', 'max'],
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ['text'],
    }),
    streamSimple: () => {
      const stream = createAssistantMessageEventStream()
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: 'route-call-1',
        name: 'route_decision',
        arguments: args,
      }
      const partial = assistantWithContent([toolCall], 'toolUse')
      stream.push({ type: 'start', partial })
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
      stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial })
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial })
      stream.push({ type: 'done', reason: 'toolUse', message: partial })
      return stream
    },
  } as unknown as ModelService
}

function assistantWithContent(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    ...assistant(''),
    content,
    stopReason,
  }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'router-model',
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

const recentMessages: VisibleMessage[] = [{
  id: 'user-1',
  threadId: 'primary',
  seq: 1,
  role: 'user',
  content: 'Earlier context',
  metadata: {},
  sourceRefs: [],
  createdAt: '2026-11-18T00:00:00.000Z',
}]

function fakeToolSequence(responses: Array<{ name: string; arguments: ToolCall['arguments'] } | string>): ModelService {
  const selection: ModelSelection = { providerId: 'openai', modelId: 'router-model' }
  let index = 0
  return {
    getSnapshot: async () => ({
      providers: [],
      defaultModel: selection,
      defaultReasoningEffort: 'max',
      modelSettingsVersion: 1,
    }),
    getModelDescriptor: () => ({
      id: 'router-model',
      name: 'Router Model',
      providerId: 'openai',
      api: 'openai-responses',
      reasoning: true,
      reasoningEfforts: ['high', 'max'],
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ['text'],
    }),
    streamSimple: () => {
      const response = responses[index++] ?? responses.at(-1)!
      const stream = createAssistantMessageEventStream()
      if (typeof response === 'string') {
        const partial = assistant(response)
        stream.push({ type: 'start', partial: assistant('') })
        stream.push({ type: 'text_start', contentIndex: 0, partial: assistant('') })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: response, partial })
        stream.push({ type: 'text_end', contentIndex: 0, content: response, partial })
        stream.push({ type: 'done', reason: 'stop', message: partial })
        return stream
      }
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: `call-${index}`,
        name: response.name,
        arguments: response.arguments,
      }
      const partial = assistantWithContent([toolCall], 'toolUse')
      stream.push({ type: 'start', partial })
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
      stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(response.arguments), partial })
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial })
      stream.push({ type: 'done', reason: 'toolUse', message: partial })
      return stream
    },
  } as unknown as ModelService
}

function connectorGateway(): RouterConnectorGateway & {
  list: ReturnType<typeof vi.fn>
  callRead: ReturnType<typeof vi.fn>
} {
  return {
    list: vi.fn(async () => ({
      definitions: [EMAIL_CONNECTOR],
      instances: [{
        id: 'connector-1',
        kind: 'email',
        name: 'Work mail',
        enabled: true,
        configured: true,
        status: 'ready' as const,
        config: {},
        capabilities: EMAIL_CONNECTOR.capabilities,
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt: '2026-11-24T00:00:00.000Z',
      }],
    })),
    callRead: vi.fn(async () => ({ kind: 'result' as const, value: { messages: [{ subject: 'Build finished' }] } })),
  }
}

describe('ModelRouterDecisionEngine', () => {
  it('prefers a native route_decision tool call over text JSON', async () => {
    const args = {
      tool: 'reply',
      arguments: { text: 'Wear a coat.' },
      confidence: 0.98,
      rationaleCodes: ['direct_reply'],
    } satisfies ToolCall['arguments']
    const model = fakeModelWithToolCall(args)
    const stream = vi.spyOn(model, 'streamSimple')
    const engine = new ModelRouterDecisionEngine(model)

    await expect(engine.decide(input())).resolves.toMatchObject({
      action: 'reply',
      text: 'Wear a coat.',
    })
    expect(stream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'route_decision' })],
      }),
      expect.objectContaining({ toolChoice: 'auto' }),
    )
  })

  it('parses a validated task.create tool decision and preserves reasoning effort', async () => {
    const response = JSON.stringify({
      tool: 'task.create',
      arguments: {
        title: 'Prepare the comparison',
        objective: 'Compare the three vendors.',
        deliverable: 'A concise comparison.',
        constraints: [],
        acceptanceCriteria: ['All three vendors are compared.'],
        forbiddenActions: [],
        risk: 'none',
        expectedArtifacts: [],
      },
      confidence: 0.94,
      rationaleCodes: ['durable_work'],
    })
    const model = fakeModel(response)
    const stream = vi.spyOn(model, 'streamSimple')
    const memory = {
      contextForPromptWithSources: vi.fn(() => ({
        context: '\n<memory_context>Prefer concise reports.</memory_context>',
        sourceRefs: ['memory:1'],
      })),
    }
    const engine = new ModelRouterDecisionEngine(model, memory)

    const decision = await engine.decide(input())

    expect(decision).toMatchObject({
      action: 'create_task',
      title: 'Prepare the comparison',
      memoryRefs: ['memory:1'],
      taskContract: {
        objective: 'Compare the three vendors.',
        acceptanceCriteria: ['All three vendors are compared.'],
      },
    })
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', modelId: 'router-model' }),
      expect.anything(),
      expect.objectContaining({ reasoning: 'max' }),
    )
  })

  it('accepts a minimal task contract and fills host-owned defaults', async () => {
    const response = JSON.stringify({
      tool: 'task.create',
      arguments: {
        title: 'Write the note',
        objective: 'Write a short note in the workspace.',
      },
      confidence: 0.96,
      rationaleCodes: ['durable_work'],
    })
    const engine = new ModelRouterDecisionEngine(fakeModel(response))

    const decision = await engine.decide(input())

    expect(decision).toMatchObject({
      action: 'create_task',
      taskContract: {
        objective: 'Write a short note in the workspace.',
        deliverable: 'Complete the requested task.',
        constraints: [],
        acceptanceCriteria: [],
        forbiddenActions: [],
        risk: 'none',
        expectedArtifacts: [],
      },
    })
  })

  it('retries once after an invalid model response', async () => {
    const valid = JSON.stringify({
      tool: 'reply',
      arguments: { text: 'Wear a coat.' },
      confidence: 0.97,
      rationaleCodes: ['direct_reply'],
    })
    const model = fakeSequencedModel(['I think you should wear a coat.', valid])
    const stream = vi.spyOn(model, 'streamSimple')
    const engine = new ModelRouterDecisionEngine(model)

    await expect(engine.decide(input())).resolves.toMatchObject({
      action: 'reply',
      text: 'Wear a coat.',
    })
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[1]?.[1].messages.at(-1)?.content).toContain('did not match the route_decision schema')
  })

  it('gives the Router pending approvals and the Task result summary', async () => {
    const model = fakeModel(JSON.stringify({
      tool: 'reply',
      arguments: { text: 'Use the approval card in the Task result.' },
      confidence: 0.99,
      rationaleCodes: ['approval_card_visible'],
    }))
    const stream = vi.spyOn(model, 'streamSimple')
    const engine = new ModelRouterDecisionEngine(model)
    const taskId = '22222222-2222-4222-8222-222222222222'
    const approvalId = '33333333-3333-4333-8333-333333333333'

    await engine.decide({
      ...input(),
      activeTasks: [{
        id: taskId,
        title: 'Send the update',
        status: 'waiting',
        origin: 'user',
        waitingReason: 'approval',
        approvalId,
        result: {
          outcome: 'needs_review',
          summary: 'The message is waiting for approval.',
          artifacts: [],
          evidenceRefs: [],
          limitations: [],
          externalEffectReceipts: [],
        },
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt: '2026-11-24T00:00:01.000Z',
      }],
      pendingApprovals: [{
        id: approvalId,
        kind: 'external-write',
        title: 'Send update',
        summary: 'Send the update to the team.',
        taskId,
        status: 'pending',
        createdAt: '2026-11-24T00:00:01.000Z',
      }],
    })

    const content = stream.mock.calls[0]?.[1].messages[1]?.content
    expect(typeof content).toBe('string')
    const context = JSON.parse(content as string) as {
      pendingApprovals: Array<Record<string, unknown>>
      activeTasks: Array<Record<string, unknown>>
    }
    expect(context.pendingApprovals[0]).toMatchObject({ id: approvalId, taskId, status: 'pending' })
    expect(context.activeTasks[0]).toMatchObject({
      id: taskId,
      waitingReason: 'approval',
      approvalId,
      result: { summary: 'The message is waiting for approval.' },
    })
  })

  it('executes connector discovery inside the Router and replies without creating a Task', async () => {
    const model = fakeToolSequence([
      { name: 'call', arguments: { tool: 'connector.list', params: {} } },
      {
        name: 'route_decision',
        arguments: {
          tool: 'reply',
          arguments: { text: 'You have one email connector configured.' },
          confidence: 0.98,
          rationaleCodes: ['direct_connector_inventory'],
        },
      },
    ])
    const gateway = connectorGateway()
    const stream = vi.spyOn(model, 'streamSimple')
    const engine = new ModelRouterDecisionEngine(model, undefined, gateway)

    await expect(engine.decide(input())).resolves.toMatchObject({
      action: 'reply',
      text: 'You have one email connector configured.',
    })
    expect(gateway.list).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[1]?.[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'toolResult', toolName: 'call', isError: false }),
    ]))
  })

  it('allows one read-only connector lookup inside the Router', async () => {
    const model = fakeToolSequence([
      {
        name: 'call',
        arguments: {
          tool: 'connector.read',
          params: {
            connectorId: 'connector-1',
            capability: 'email.list',
            arguments: { limit: 5 },
          },
        },
      },
      {
        name: 'route_decision',
        arguments: {
          tool: 'reply',
          arguments: { text: 'The latest message is “Build finished”.' },
          confidence: 0.97,
          rationaleCodes: ['direct_connector_read'],
        },
      },
    ])
    const gateway = connectorGateway()
    const engine = new ModelRouterDecisionEngine(model, undefined, gateway)

    await expect(engine.decide(input())).resolves.toMatchObject({
      action: 'reply',
      text: 'The latest message is “Build finished”.',
    })
    expect(gateway.callRead).toHaveBeenCalledWith({
      connectorId: 'connector-1',
      capability: 'email.list',
      arguments: { limit: 5 },
    })
  })

  it('fails closed when the Router returns unstructured text', async () => {
    const engine = new ModelRouterDecisionEngine(fakeModel('A quick direct answer.'))
    await expect(engine.decide(input())).rejects.toThrow('invalid tool decision')
  })

  it('rejects an invalid structured decision instead of guessing', async () => {
    const engine = new ModelRouterDecisionEngine(fakeModel('{"tool":"task.create","arguments":{}}'))
    await expect(engine.decide(input())).rejects.toThrow('invalid tool decision')
  })
})

function input() {
  return {
    text: 'Do the work',
    attachments: [],
    recentMessages,
    activeTasks: [],
    pendingApprovals: [],
    connectors: [],
    workingDirectory: '/tmp/project',
    now: new Date('2026-11-18T00:00:00.000Z'),
    timezone: 'Asia/Shanghai',
  }
}
