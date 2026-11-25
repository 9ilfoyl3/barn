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
  type ConnectorCallInput,
  type ConnectorCallResult,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ModelSelection,
  type RoutineRecurrence,
  type Task,
  type TaskContract,
} from '../../shared/models'
import { composeRouterSystemPrompt } from '../../shared/agent-prompts'
import type { ModelService } from '../models/model-service'
import type { MemoryService } from '../memory/memory-service'
import type { VisibleMessage } from '../../shared/models'

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
  tool: z.enum(['connector.list', 'connector.read']),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict()

const connectorReadInputSchema = z.object({
  connectorId: z.string().trim().min(1).max(80),
  capability: z.string().trim().min(1).max(160),
  arguments: z.record(z.string(), z.unknown()).default({}),
}).strict()

const ROUTER_CALL_TOOL: Tool = {
  name: 'call',
  description: 'Run one bounded Router capability call. connector.list inspects configured connectors and capability schemas. connector.read performs one read-only connector lookup. External writes are unavailable here.',
  parameters: Type.Object({
    tool: Type.Union([Type.Literal('connector.list'), Type.Literal('connector.read')]),
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
}

export interface RouterConnectorSnapshot {
  definitions: ConnectorDefinition[]
  instances: ConnectorInstance[]
}

export interface RouterConnectorGateway {
  list(): Promise<RouterConnectorSnapshot>
  callRead(input: ConnectorCallInput): Promise<ConnectorCallResult>
}

export interface RouterDecisionEngine {
  decide(input: RouterDecisionInput, signal?: AbortSignal): Promise<RouterDecision>
}

type RouterModel = Pick<ModelService, 'getSnapshot' | 'getModelDescriptor' | 'streamSimple'>

const MAX_RESPONSE_CHARS = 100_000
const RECENT_CONTEXT_CHAR_LIMIT = 16_000
const MAX_ROUTER_ROUNDS = 6
const MAX_ROUTER_REPAIRS = 1

/** Model-backed Router tool selection. Tool arguments are validated before any write. */
export class ModelRouterDecisionEngine implements RouterDecisionEngine {
  constructor(
    private readonly model: RouterModel,
    private readonly memory?: Pick<MemoryService, 'contextForPromptWithSources'>,
    private readonly connectors?: RouterConnectorGateway,
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
    const baseContext: Context = {
      messages: [
        {
          role: 'system',
          content: composeRouterSystemPrompt({ connectorToolsAvailable: this.connectors !== undefined }),
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
      tools: this.connectors === undefined
        ? [ROUTER_DECISION_TOOL]
        : [ROUTER_CALL_TOOL, ROUTER_DECISION_TOOL],
    }
    const reasoning = resolveReasoningEffort(snapshot.defaultReasoningEffort, descriptor.reasoningEfforts)
    let context = baseContext
    let repairHint: string | undefined
    let lastError: unknown
    let repairs = 0
    let connectorReads = 0
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
          if (this.connectors === undefined) throw new Error('Router connector capabilities are unavailable')
          const results: ToolResultMessage[] = []
          for (const call of capabilityCalls) {
            const executed = await executeRouterCapabilityCall(call, this.connectors, connectorReads)
            if (executed.readStarted) connectorReads++
            results.push(toolResult(call, executed.value, executed.isError))
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

interface RouterCapabilityResult {
  value: unknown
  isError: boolean
  readStarted: boolean
}

async function executeRouterCapabilityCall(
  call: ToolCall,
  gateway: RouterConnectorGateway,
  connectorReads: number,
): Promise<RouterCapabilityResult> {
  try {
    const parsed = routerCallSchema.parse(call.arguments)
    if (parsed.tool === 'connector.list') {
      return { value: await gateway.list(), isError: false, readStarted: false }
    }
    if (connectorReads >= 1) {
      return {
        value: { error: 'Only one read-only connector lookup is allowed for a direct Router turn.' },
        isError: true,
        readStarted: false,
      }
    }
    const input = connectorReadInputSchema.parse(parsed.params)
    const result = await gateway.callRead(input)
    if (result.kind !== 'result') {
      return {
        value: { error: 'The Router connector path returned an action instead of a read result.' },
        isError: true,
        readStarted: false,
      }
    }
    return { value: result.value, isError: false, readStarted: true }
  } catch (error) {
    return {
      value: { error: error instanceof Error ? error.message : String(error) },
      isError: true,
      readStarted: false,
    }
  }
}

function toolResult(call: ToolCall, value: unknown, isError: boolean): ToolResultMessage {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: text.slice(0, MAX_RESPONSE_CHARS) }],
    isError,
    timestamp: Date.now(),
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
