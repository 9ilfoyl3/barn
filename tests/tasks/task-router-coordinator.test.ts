import { createAssistantMessageEventStream, type AssistantMessage, type Context, type SimpleStreamOptions, type ToolCall } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, Task } from '../../src/shared/models'
import type { ModelService } from '../../src/main/models/model-service'
import { ModelTaskRouterDecisionEngine } from '../../src/main/tasks/task-router-coordinator'

const selection: ModelSelection = { providerId: 'openai', modelId: 'task-router-model' }

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'task-router-model',
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

function modelWithToolCall(args: ToolCall['arguments']): ModelService {
  return {
    getSnapshot: async () => ({
      providers: [],
      defaultModel: selection,
      defaultReasoningEffort: 'max',
      modelSettingsVersion: 1,
    }),
    getModelDescriptor: () => ({
      id: 'task-router-model',
      name: 'Task Router Model',
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
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: 'coordination-call-1',
        name: 'coordinate_task_message',
        arguments: args,
      }
      const partial = {
        ...assistant(''),
        content: [toolCall],
        stopReason: 'toolUse' as const,
      }
      stream.push({ type: 'start', partial })
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
      stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial })
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial })
      stream.push({ type: 'done', reason: 'toolUse', message: partial })
      return stream
    },
  } as unknown as ModelService
}

function task(): Task {
  return {
    id: '4d8c8078-91a0-4f89-b2a1-b4a4eb4d7558',
    title: 'Check the weather',
    status: 'running',
    origin: 'user',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  }
}

function input() {
  return {
    task: task(),
    text: 'what is the status?',
    attachments: [],
    recentEvents: [],
    now: new Date('2026-11-20T00:00:00.000Z'),
    timezone: 'Asia/Shanghai',
  }
}

describe('ModelTaskRouterDecisionEngine', () => {
  it('uses a native coordination tool and never grants execution tools', async () => {
    const model = modelWithToolCall({
      tool: 'router.reply',
      arguments: { text: 'Still running.' },
      confidence: 0.98,
      rationaleCodes: ['status_reply'],
    })
    const stream = vi.spyOn(model, 'streamSimple')
    const engine = new ModelTaskRouterDecisionEngine(model)

    await expect(engine.decide(input())).resolves.toMatchObject({
      action: 'reply',
      text: 'Still running.',
    })
    expect(stream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'coordinate_task_message' })],
      }),
      expect.objectContaining({ toolChoice: 'auto' }),
    )
  })

  it('passes the Task language into the Task Router prompt', async () => {
    const model = modelWithToolCall({
      tool: 'router.reply',
      arguments: { text: '任务仍在执行。' },
      confidence: 0.98,
      rationaleCodes: ['status_reply'],
    })
    const stream = vi.spyOn(model, 'streamSimple')
    const engine = new ModelTaskRouterDecisionEngine(model)

    await engine.decide({ ...input(), locale: 'zh-CN' })

    const system = stream.mock.calls[0]?.[1].messages[0]?.content
    expect(system).toContain('## Channel and language')
    expect(system).toContain('Preferred UI language: Simplified Chinese')
  })

  it('routes actionable work to the Worker without generating a visible answer', async () => {
    const model = modelWithToolCall({
      tool: 'worker.dispatch',
      arguments: {},
      confidence: 0.97,
      rationaleCodes: ['worker_owns_execution'],
    })
    const engine = new ModelTaskRouterDecisionEngine(model)

    await expect(engine.decide({ ...input(), text: 'Check Shanghai tomorrow too.' })).resolves.toMatchObject({
      action: 'delegate',
    })
  })
})
