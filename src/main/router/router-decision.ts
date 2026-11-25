import { Type } from 'typebox'
import { z } from 'zod'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import {
  resolveReasoningEffort,
  type ApprovalRequest,
  type ModelSelection,
  type RoutineRecurrence,
  type Task,
  type TaskContract,
} from '../../shared/models'
import { composeRouterSystemPrompt, type AgentLocale } from '../../shared/agent-prompts'
import type { ModelService } from '../models/model-service'
import type { MemoryService } from '../memory/memory-service'
import type { VisibleMessage } from '../../shared/models'
import type { RouterToolGateway } from '../../shared/router-tools'
import type { ToolExecutionResult } from '../../shared/agent-protocol'

const decisionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('reply'),
    arguments: z.object({
      text: z.string().trim().min(1).max(20_000),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.85),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['direct_reply']),
  }).strict(),
  z.object({
    tool: z.literal('clarify'),
    arguments: z.object({
      question: z.string().trim().min(1).max(4_000),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.85),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['clarification_required']),
  }).strict(),
  z.object({
    tool: z.literal('task.create'),
    arguments: z.object({
      title: z.string().trim().min(1).max(200),
      objective: z.string().trim().min(1).max(20_000),
      deliverable: z.string().trim().min(1).max(2_000).default('Complete the requested task.'),
      constraints: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
      acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
      forbiddenActions: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
      risk: z.enum(['none', 'local_write', 'external_write', 'destructive']).default('none'),
      expectedArtifacts: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['durable_work']),
  }).strict(),
  z.object({
    tool: z.literal('schedule.create'),
    arguments: z.object({
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(20_000),
      scheduledFor: z.string().datetime({ offset: true }),
      timezone: z.string().trim().min(1).max(100),
      recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly']).default('none'),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['scheduled_reminder']),
  }).strict(),
  z.object({
    tool: z.literal('routine.update'),
    arguments: z.object({
      taskId: z.string().uuid(),
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(20_000),
      scheduledFor: z.string().datetime({ offset: true }),
      timezone: z.string().trim().min(1).max(100),
      recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly']),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['routine_update']),
  }).strict(),
  z.object({
    tool: z.literal('task.cancel'),
    arguments: z.object({
      taskId: z.string().uuid(),
      reason: z.string().trim().max(1_000).optional(),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['explicit_cancel']),
  }).strict(),
  z.object({
    tool: z.literal('task.update'),
    arguments: z.object({
      taskId: z.string().uuid(),
      instruction: z.string().trim().min(1).max(20_000),
    }).strict(),
    confidence: z.number().min(0).max(1).default(0.9),
    rationaleCodes: z.array(z.string().min(1).max(80)).max(20).default(['explicit_update']),
  }).strict(),
])

const routerCallSchema = z.object({
  tool: z.string().trim().min(1).max(160),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict()

const ROUTER_CALL_TOOL: Tool = {
  name: 'call',
  description: 'Call one ordinary business tool disclosed in the Tool Disclosure. Set tool to the exact tool name and params to that tool input object. Calls execute sequentially; multiple rounds are allowed within the host budget.',
  parameters: Type.Object({
    tool: Type.String({ minLength: 1, maxLength: 160 }),
    params: Type.Record(Type.String(), Type.Unknown()),
  }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
}

const ROUTER_DECISION_TOOL: Tool = {
  name: 'route_decision',
  description: 'Choose exactly one Router action for the current user message. The runtime validates the arguments before applying any effect.',
  parameters: Type.Object({
    tool: Type.Union([
      Type.Literal('reply'),
      Type.Literal('clarify'),
      Type.Literal('task.create'),
      Type.Literal('schedule.create'),
      Type.Literal('routine.update'),
      Type.Literal('task.cancel'),
      Type.Literal('task.update'),
    ]),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    rationaleCodes: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }),
  }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
}

export type RouterDecision =
  | {
      action: 'reply'
      text: string
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'clarify'
      question: string
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'create_task'
      title: string
      taskContract: TaskContract
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'schedule'
      title: string
      text: string
      scheduledFor: string
      timezone: string
      recurrence: RoutineRecurrence
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'update_routine'
      taskId: string
      title: string
      text: string
      scheduledFor: string
      timezone: string
      recurrence: RoutineRecurrence
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'cancel_task'
      taskId: string
      reason?: string
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }
  | {
      action: 'update_task'
      taskId: string
      instruction: string
      confidence: number
      rationaleCodes: string[]
      memoryRefs: string[]
    }

export interface RouterDecisionInput {
  text: string
  attachments: Array<{ name: string; kind?: 'file' | 'directory' }>
  recentMessages: VisibleMessage[]
  activeTasks: Task[]
  pendingApprovals: ApprovalRequest[]
  connectors: Array<{ id: string; kind: string; name: string; status: string; capabilities: string[] }>
  workingDirectory?: string
  now: Date
  timezone: string
  locale?: AgentLocale
}

export interface RouterDecisionEngine {
  decide(input: RouterDecisionInput, signal?: AbortSignal): Promise<RouterDecision>
}

type RouterModel = Pick<ModelService, 'getSnapshot' | 'getModelDescriptor' | 'streamSimple'>

const MAX_RESPONSE_CHARS = 100_000
const RECENT_CONTEXT_CHAR_LIMIT = 16_000
const MAX_ROUTER_ROUNDS = 10
const MAX_ROUTER_REPAIRS = 1
const MAX_ROUTER_TOOL_CALLS = 8
const MAX_ROUTER_TOOL_OUTPUT_CHARS = 120_000

/** Model-backed Router tool selection. Tool arguments are validated before any write. */
export class ModelRouterDecisionEngine implements RouterDecisionEngine {
  constructor(
    private readonly model: RouterModel,
    private readonly memory?: Pick<MemoryService, 'contextForPromptWithSources'>,
    private readonly tools?: RouterToolGateway,
  ) {}

  async decide(input: RouterDecisionInput, signal?: AbortSignal): Promise<RouterDecision> {
    const snapshot = await this.model.getSnapshot()
    const selection: ModelSelection | undefined = snapshot.defaultModel
    if (selection === undefined) throw new Error('Configure a default model before sending a message')
    const descriptor = this.model.getModelDescriptor(selection)
    if (descriptor === undefined) throw new Error('The selected model is no longer available')
    let memory = { context: '', sourceRefs: [] as string[] }
    try {
      memory = this.memory?.contextForPromptWithSources(input.text, input.workingDirectory)
        ?? { context: '', sourceRefs: [] }
    } catch {
      // Confirmed memory is optional and must never block routing.
    }
    const disclosedTools = this.tools?.listTools() ?? []
    const routerTools = descriptor.input.includes('image')
      ? disclosedTools
      : disclosedTools.filter((tool) => tool.name !== 'view_image')
    const baseContext: Context = {
      messages: [
        {
          role: 'system',
          content: composeRouterSystemPrompt({
            tools: routerTools,
            ...(input.locale === undefined ? {} : { locale: input.locale }),
          }),
          timestamp: input.now.getTime(),
        },
        {
          role: 'user',
          content: JSON.stringify({
            currentTime: input.now.toISOString(),
            timezone: input.timezone,
            workingDirectory: input.workingDirectory ?? null,
            userMessage: input.text,
            attachments: input.attachments,
            connectors: input.connectors,
            pendingApprovals: input.pendingApprovals.map((approval) => ({
              id: approval.id,
              taskId: approval.taskId ?? null,
              kind: approval.kind,
              title: approval.title,
              summary: approval.summary,
              status: approval.status,
              createdAt: approval.createdAt,
            })),
            activeTasks: input.activeTasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              kind: task.kind ?? 'work',
              waitingReason: task.waitingReason ?? null,
              detail: task.detail ?? null,
              approvalId: task.approvalId ?? null,
              result: task.result === undefined
                ? null
                : {
                    outcome: task.result.outcome,
                    summary: task.result.summary,
                    limitations: task.result.limitations,
                  },
              scheduledFor: task.scheduledFor ?? null,
              recurrence: task.recurrence ?? 'none',
              timezone: task.timezone ?? null,
            })),
            recentVisibleContext: recentContext(input.recentMessages),
            memoryContext: memory.context || null,
          }),
          timestamp: input.now.getTime(),
        },
      ],
      tools: routerTools.length === 0
        ? [ROUTER_DECISION_TOOL]
        : [ROUTER_CALL_TOOL, ROUTER_DECISION_TOOL],
    }
    const reasoning = resolveReasoningEffort(snapshot.defaultReasoningEffort, descriptor.reasoningEfforts)
    let context = baseContext
    let repairHint: string | undefined
    let lastError: unknown
    let repairs = 0
    let executedToolCalls = 0
    let toolOutputChars = 0
    for (let round = 0; round < MAX_ROUTER_ROUNDS; round++) {
      const requestContext: Context = repairHint === undefined
        ? context
        : {
            ...context,
            messages: [
              ...context.messages,
              {
                role: 'user',
                content: `${repairHint}
Call the route_decision tool now. Do not answer in prose. If native tool calls are unavailable, return only the tool arguments as strict JSON.`,
                timestamp: input.now.getTime(),
              },
            ],
          }
      const options: SimpleStreamOptions = {
        maxTokens: 3_000,
        cacheRetention: 'none',
        toolChoice: 'auto',
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(signal === undefined ? {} : { signal }),
      }
      const output = await collectRouterOutput(this.model.streamSimple(selection, requestContext, options))
      const decisionCalls = output.toolCalls.filter((call) => call.name === ROUTER_DECISION_TOOL.name)
      const capabilityCalls = output.toolCalls.filter((call) => call.name === ROUTER_CALL_TOOL.name)
      const unknownCalls = output.toolCalls.filter((call) => (
        call.name !== ROUTER_DECISION_TOOL.name && call.name !== ROUTER_CALL_TOOL.name
      ))
      try {
        if (unknownCalls.length > 0) {
          throw new Error(`Router called unknown tool: ${unknownCalls.map((call) => call.name).join(', ')}`)
        }
        if (decisionCalls.length > 0) {
          if (decisionCalls.length !== 1 || capabilityCalls.length > 0) {
            throw new Error('Router must call route_decision exactly once and without execution calls')
          }
          return toRouterDecision(parseToolCallDecision(decisionCalls[0]!), memory.sourceRefs)
        }
        if (capabilityCalls.length > 0) {
          if (this.tools === undefined || routerTools.length === 0) {
            throw new Error('Router ordinary tool execution is unavailable')
          }
          const results: ToolResultMessage[] = []
          for (const call of capabilityCalls) {
            let result: ToolExecutionResult
            if (executedToolCalls >= MAX_ROUTER_TOOL_CALLS) {
              result = errorToolResult(`Router tool-call budget exhausted after ${MAX_ROUTER_TOOL_CALLS} calls. Finish with reply, or create a Task for the remaining work.`)
            } else if (toolOutputChars >= MAX_ROUTER_TOOL_OUTPUT_CHARS) {
              result = errorToolResult('Router tool-output budget exhausted. Finish with reply, or create a Task for the remaining work.')
            } else {
              result = await executeRouterToolCall(call, this.tools, routerTools.map((tool) => tool.name), {
                ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
                ...(signal === undefined ? {} : { signal }),
              })
              executedToolCalls++
              toolOutputChars += toolResultCharacterCount(result)
            }
            results.push(toolResult(call, result))
          }
          context = {
            ...context,
            messages: [...context.messages, output.message, ...results],
          }
          repairHint = undefined
          continue
        }
        return toRouterDecision(parseDecisionResponse(output.text), memory.sourceRefs)
      } catch (error) {
        lastError = error
        if (repairs >= MAX_ROUTER_REPAIRS) break
        repairs++
        repairHint = routerRepairHint(error, output)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Router returned an invalid tool decision')
  }
}

function recentContext(messages: VisibleMessage[]): Array<{ role: string; content: string }> {
  const selected: Array<{ role: string; content: string }> = []
  let size = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || (message.role !== 'user' && message.role !== 'assistant')) continue
    const content = visibleText(message.content).trim()
    if (content.length === 0) continue
    if (size + content.length > RECENT_CONTEXT_CHAR_LIMIT && selected.length > 0) break
    selected.unshift({ role: message.role, content })
    size += content.length
  }
  return selected
}

function parseDecisionResponse(response: string): z.infer<typeof decisionSchema> {
  const trimmed = response.trim()
  if (trimmed.length === 0) throw new Error('Router returned an empty decision')
  try {
    return decisionSchema.parse(JSON.parse(stripFence(trimmed)))
  } catch (error) {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return decisionSchema.parse(JSON.parse(trimmed.slice(start, end + 1)))
      } catch {
        // Fall through to direct reply compatibility for simple model responses.
      }
    }
    throw new Error('Router returned an invalid tool decision', { cause: error })
  }
}

function toRouterDecision(
  value: z.infer<typeof decisionSchema>,
  memoryRefs: string[],
): RouterDecision {
  if (value.tool === 'reply') {
    return {
      action: 'reply',
      text: value.arguments.text,
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  if (value.tool === 'clarify') {
    return {
      action: 'clarify',
      question: value.arguments.question,
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  if (value.tool === 'task.create') {
    return {
      action: 'create_task',
      title: value.arguments.title,
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
      taskContract: {
        objective: value.arguments.objective,
        deliverable: value.arguments.deliverable,
        constraints: value.arguments.constraints,
        inputRefs: [],
        sourceRefs: memoryRefs,
        acceptanceCriteria: value.arguments.acceptanceCriteria,
        forbiddenActions: value.arguments.forbiddenActions,
        risk: value.arguments.risk,
        executionLane: 'background',
        expectedArtifacts: value.arguments.expectedArtifacts,
      },
    }
  }
  if (value.tool === 'schedule.create') {
    return {
      action: 'schedule',
      title: value.arguments.title,
      text: value.arguments.text,
      scheduledFor: value.arguments.scheduledFor,
      timezone: value.arguments.timezone,
      recurrence: value.arguments.recurrence,
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  if (value.tool === 'routine.update') {
    return {
      action: 'update_routine',
      taskId: value.arguments.taskId,
      title: value.arguments.title,
      text: value.arguments.text,
      scheduledFor: value.arguments.scheduledFor,
      timezone: value.arguments.timezone,
      recurrence: value.arguments.recurrence,
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  if (value.tool === 'task.cancel') {
    return {
      action: 'cancel_task',
      taskId: value.arguments.taskId,
      ...(value.arguments.reason === undefined ? {} : { reason: value.arguments.reason }),
      confidence: value.confidence,
      rationaleCodes: value.rationaleCodes,
      memoryRefs,
    }
  }
  return {
    action: 'update_task',
    taskId: value.arguments.taskId,
    instruction: value.arguments.instruction,
    confidence: value.confidence,
    rationaleCodes: value.rationaleCodes,
    memoryRefs,
  }
}

function stripFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part): string[] => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return []
    const record = part as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('\n')
}

interface RouterRoundOutput {
  text: string
  message: AssistantMessage
  toolCalls: ToolCall[]
}

async function executeRouterToolCall(
  call: ToolCall,
  gateway: RouterToolGateway,
  availableTools: readonly string[],
  context: { workingDirectory?: string; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  try {
    const parsed = routerCallSchema.parse(call.arguments)
    if (!availableTools.includes(parsed.tool)) {
      return errorToolResult(`Unknown or unavailable Router tool: ${parsed.tool}. Available tools: ${availableTools.join(', ')}`)
    }
    return await gateway.execute(parsed.tool, parsed.params, context)
  } catch (error) {
    return errorToolResult(error instanceof Error ? error.message : String(error))
  }
}

function toolResult(call: ToolCall, result: ToolExecutionResult): ToolResultMessage {
  const content = result.content.flatMap((part): ToolResultMessage['content'] => {
    if (part.type === 'text') {
      return [{ type: 'text', text: part.text.slice(0, MAX_RESPONSE_CHARS) }]
    }
    return [{ type: 'image', data: part.data, mimeType: part.mimeType }]
  })
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: content.length === 0 ? [{ type: 'text', text: '(no tool output)' }] : content,
    isError: result.isError === true,
    timestamp: Date.now(),
  }
}

function toolResultCharacterCount(result: ToolExecutionResult): number {
  return result.content.reduce((total, part) => (
    total + (part.type === 'text' ? part.text.length : part.data.length)
  ), 0)
}

function errorToolResult(message: string): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
    isError: true,
  }
}

async function collectRouterOutput(stream: AssistantMessageEventStream): Promise<RouterRoundOutput> {
  let text = ''
  let message: AssistantMessage | undefined
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'Router model failed')
    if (event.type === 'done') {
      message = event.message
      break
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new Error('Router response was too large')
  }
  if (message === undefined) throw new Error('Router model returned no final message')
  return {
    text: text || message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
    message,
    toolCalls: message.content.filter((part): part is ToolCall => part.type === 'toolCall'),
  }
}

function parseToolCallDecision(toolCall: ToolCall): z.infer<typeof decisionSchema> {
  if (toolCall.name !== ROUTER_DECISION_TOOL.name) {
    throw new Error(`Router called an unknown tool: ${toolCall.name}`)
  }
  if (toolCall.argumentsError !== undefined) throw new Error(toolCall.argumentsError)
  return decisionSchema.parse(toolCall.arguments)
}

function routerRepairHint(error: unknown, output: RouterRoundOutput): string {
  const detail = error instanceof Error ? error.message.slice(0, 1_200) : String(error).slice(0, 1_200)
  const raw = output.toolCalls.length > 0
    ? JSON.stringify(output.toolCalls).slice(0, 1_200)
    : output.text.trim().slice(0, 1_200)
  return `Your previous response did not match the route_decision schema: ${detail}
Previous response: ${raw || '(empty)'}`
}
