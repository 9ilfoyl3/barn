import { createAssistantMessageEventStream, type AssistantMessage, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, VisibleMessage } from '../../src/shared/models'
import type { ModelService } from '../../src/main/models/model-service'
import { ModelRouterDecisionEngine } from '../../src/main/router/router-decision'

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

describe('ModelRouterDecisionEngine', () => {
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
    connectors: [],
    workingDirectory: '/tmp/project',
    now: new Date('2026-11-18T00:00:00.000Z'),
    timezone: 'Asia/Shanghai',
  }
}
