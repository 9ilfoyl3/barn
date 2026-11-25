import { Type } from 'typebox'
import { z } from 'zod'
import type {
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
  Tool,
  ToolCall,
} from '@earendil-works/pi-ai'
import { resolveReasoningEffort, type AttachmentDescriptor, type ModelSelection, type Task } from '../../shared/models'
import type { ModelService } from '../models/model-service'
import type { MemoryService } from '../memory/memory-service'
import type { StoredSessionEvent } from '../session/session-store'
import { composeTaskRouterSystemPrompt } from '../../shared/agent-prompts'

export type TaskRouterDecision =
  | {
      action: 'delegate'
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'reply'
      text: string
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'cancel'
      message: string
      reason?: string
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }

export interface TaskRouterDecisionInput {
  task: Task
  text: string
  attachments: AttachmentDescriptor[]
  recentEvents: StoredSessionEvent[]
  workingDirectory?: string
  now: Date
  timezone: string
}

export interface TaskRouterDecisionEngine {
  decide(input: TaskRouterDecisionInput, signal?: AbortSignal): Promise<TaskRouterDecision>
}

const decisionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('worker.dispatch'),
    arguments: z.object({}).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['worker_owns_execution']),
  }).strict(),
  z.object({
    tool: z.literal('router.reply'),
    arguments: z.object({
      text: z.string().trim().min(1).max(20_000),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.85),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['coordination_reply']),
  }).strict(),
  z.object({
    tool: z.literal('task.cancel'),
    arguments: z.object({
      message: z.string().trim().min(1).max(4_000),
      reason: z.string().trim().max(1_000).optional(),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['explicit_cancel']),
  }).strict(),
])

const TASK_COORDINATION_TOOL: Tool = {
  name: 'coordinate_task_message',
  description: 'Choose exactly one authority for a message sent inside a Task. The Host applies only the selected action.',
  parameters: Type.Object({
    tool: Type.Union([
      Type.Literal('worker.dispatch'),
      Type.Literal('router.reply'),
      Type.Literal('task.cancel'),
    ]),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    rationaleCodes: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }),
  }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
}

type CoordinatorModel = Pick<ModelService, 'getSnapshot' | 'getModelDescriptor' | 'streamSimple'>
const MAX_RESPONSE_CHARS = 100_000
const TASK_CONTEXT_CHAR_LIMIT = 24_000

/** A no-tool coordinator decision. It can route or answer, but it cannot execute Task work. */
export class ModelTaskRouterDecisionEngine implements TaskRouterDecisionEngine {
  constructor(
    private readonly model: CoordinatorModel,
    private readonly memory?: Pick<MemoryService, 'contextForPromptWithSources'>,
  ) {}

  async decide(input: TaskRouterDecisionInput, signal?: AbortSignal): Promise<TaskRouterDecision> {
    const snapshot = await this.model.getSnapshot()
    const selection: ModelSelection | undefined = snapshot.defaultModel
    if (selection === undefined) throw new Error('Configure a default model before sending a Task message')
    const descriptor = this.model.getModelDescriptor(selection)
    if (descriptor === undefined) throw new Error('The selected model is no longer available')
    let memory = { context: '', sourceRefs: [] as string[] }
    try {
      memory = this.memory?.contextForPromptWithSources(input.text, input.workingDirectory)
        ?? { context: '', sourceRefs: [] }
    } catch {
      // Confirmed memory is optional and must never block Task coordination.
    }

    const baseContext: Context = {
      messages: [
        { role: 'system', content: composeTaskRouterSystemPrompt(), timestamp: input.now.getTime() },
        {
          role: 'user',
          content: JSON.stringify({
            currentTime: input.now.toISOString(),
            timezone: input.timezone,
            task: {
              id: input.task.id,
              title: input.task.title,
              status: input.task.status,
              detail: input.task.detail ?? null,
              contract: input.task.contract ?? null,
              result: input.task.result ?? null,
            },
            userMessage: input.text,
            attachments: input.attachments.map((attachment) => ({
              name: attachment.name,
              kind: attachment.kind ?? 'file',
            })),
            recentTaskContext: recentTaskContext(input.recentEvents),
            memoryContext: memory.context || null,
          }),
          timestamp: input.now.getTime(),
        },
      ],
      tools: [TASK_COORDINATION_TOOL],
    }
    const reasoning = resolveReasoningEffort(snapshot.defaultReasoningEffort, descriptor.reasoningEfforts)
    let repairHint: string | undefined
    let lastError: unknown

    for (let attempt = 0; attempt < 2; attempt++) {
      const context: Context = repairHint === undefined
        ? baseContext
        : {
            ...baseContext,
            messages: [
              ...baseContext.messages,
              {
                role: 'user',
                content: `${repairHint}
Call coordinate_task_message now. Do not answer in prose. If native tool calls are unavailable, return only the tool arguments as strict JSON.`,
                timestamp: input.now.getTime(),
              },
            ],
          }
      const options: SimpleStreamOptions = {
        maxTokens: 2_000,
        cacheRetention: 'none',
        toolChoice: 'auto',
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(signal === undefined ? {} : { signal }),
      }
      const output = await collectCoordinatorOutput(this.model.streamSimple(selection, context, options))
      try {
        const decision = output.toolCall === undefined
          ? parseDecisionResponse(output.text)
          : parseToolCallDecision(output.toolCall)
        return toTaskRouterDecision(decision, memory.sourceRefs)
      } catch (error) {
        lastError = error
        repairHint = coordinatorRepairHint(error, output)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Task Router returned an invalid coordination decision')
  }
}

function recentTaskContext(events: StoredSessionEvent[]): Array<Record<string, unknown>> {
  const selected: Array<Record<string, unknown>> = []
  let size = 0
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) continue
    const projected = projectContextEvent(event)
    if (projected === undefined) continue
    const serializedSize = JSON.stringify(projected).length
    if (size + serializedSize > TASK_CONTEXT_CHAR_LIMIT && selected.length > 0) break
    selected.unshift(projected)
    size += serializedSize
  }
  return selected
}

function projectContextEvent(event: StoredSessionEvent): Record<string, unknown> | undefined {
  if (event.type === 'task.result' && isRecord(event.data)) {
    return {
      type: 'task.result',
      result: event.data.result,
    }
  }
  if (event.type !== 'agent.message' || !isRecord(event.data) || !isRecord(event.data.message)) return undefined
  const message = event.data.message
  if (message.role !== 'user' && message.role !== 'assistant') return undefined
  const text = agentMessageText(message.content).trim()
  if (text.length === 0) return undefined
  return {
    type: 'message',
    role: message.role,
    actorRole: typeof event.data.actorRole === 'string' ? event.data.actorRole : event.actor.id,
    text,
  }
}

function agentMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part): string[] => (
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  )).join('\n')
}

function parseDecisionResponse(response: string): z.infer<typeof decisionSchema> {
  const trimmed = response.trim()
  if (trimmed.length === 0) throw new Error('Task Router returned an empty decision')
  try {
    return decisionSchema.parse(JSON.parse(stripFence(trimmed)))
  } catch (error) {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return decisionSchema.parse(JSON.parse(trimmed.slice(start, end + 1)))
      } catch {
        // Preserve the original parse error in the caller's repair hint.
      }
    }
    throw new Error('Task Router returned an invalid coordination decision', { cause: error })
  }
}

function toTaskRouterDecision(
  value: z.infer<typeof decisionSchema>,
  memoryRefs: string[],
): TaskRouterDecision {
  if (value.tool === 'worker.dispatch') {
    return {
      action: 'delegate',
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  if (value.tool === 'router.reply') {
    return {
      action: 'reply',
      text: value.arguments.text,
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  return {
    action: 'cancel',
    message: value.arguments.message,
    ...(value.arguments.reason === undefined ? {} : { reason: value.arguments.reason }),
    confidence: value.confidence,
    rationaleCodes: value.rationaleCodes,
    memoryRefs,
  }
}

function stripFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

async function collectCoordinatorOutput(stream: AssistantMessageEventStream): Promise<{ text: string; toolCall?: ToolCall }> {
  let text = ''
  let toolCall: ToolCall | undefined
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta
    if (event.type === 'toolcall_end') toolCall = event.toolCall
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'Task Router model failed')
    if (event.type === 'done') break
    if (text.length > MAX_RESPONSE_CHARS) throw new Error('Task Router response was too large')
  }
  return { text, ...(toolCall === undefined ? {} : { toolCall }) }
}

function parseToolCallDecision(toolCall: ToolCall): z.infer<typeof decisionSchema> {
  if (toolCall.name !== TASK_COORDINATION_TOOL.name) {
    throw new Error(`Task Router called an unknown tool: ${toolCall.name}`)
  }
  if (toolCall.argumentsError !== undefined) throw new Error(toolCall.argumentsError)
  return decisionSchema.parse(toolCall.arguments)
}

function coordinatorRepairHint(error: unknown, output: { text: string; toolCall?: ToolCall }): string {
  const detail = error instanceof Error ? error.message.slice(0, 1_200) : String(error).slice(0, 1_200)
  const raw = output.toolCall === undefined
    ? output.text.trim().slice(0, 1_200)
    : JSON.stringify(output.toolCall).slice(0, 1_200)
  return `Your previous response did not match the coordinate_task_message schema: ${detail}\nPrevious response: ${raw || '(empty)'}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
