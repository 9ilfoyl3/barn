import { z } from 'zod'
import type {
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { resolveReasoningEffort, type ModelSelection, type RoutineRecurrence, type Task, type TaskContract } from '../../shared/models'
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
      deliverable: z.string().trim().min(1).max(2_000),
      constraints: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
      acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).max(50).min(1),
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
  connectors: Array<{ id: string; kind: string; name: string; status: string; capabilities: string[] }>
  workingDirectory?: string
  now: Date
  timezone: string
}

export interface RouterDecisionEngine {
  decide(input: RouterDecisionInput, signal?: AbortSignal): Promise<RouterDecision>
}

type RouterModel = Pick<ModelService, 'getSnapshot' | 'getModelDescriptor' | 'streamSimple'>

const MAX_RESPONSE_CHARS = 100_000
const RECENT_CONTEXT_CHAR_LIMIT = 16_000

/** Model-backed Router tool selection. Tool arguments are validated before any write. */
export class ModelRouterDecisionEngine implements RouterDecisionEngine {
  constructor(
    private readonly model: RouterModel,
    private readonly memory?: Pick<MemoryService, 'contextForPromptWithSources'>,
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
    const context: Context = {
      messages: [
        { role: 'system', content: routerSystemPrompt(), timestamp: input.now.getTime() },
        {
          role: 'user',
          content: JSON.stringify({
            currentTime: input.now.toISOString(),
            timezone: input.timezone,
            workingDirectory: input.workingDirectory ?? null,
            userMessage: input.text,
            attachments: input.attachments,
            connectors: input.connectors,
            activeTasks: input.activeTasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              kind: task.kind ?? 'work',
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
    }
    const reasoning = resolveReasoningEffort(snapshot.defaultReasoningEffort, descriptor.reasoningEfforts)
    const stream = this.model.streamSimple(selection, context, {
      maxTokens: 2_000,
      cacheRetention: 'none',
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(signal === undefined ? {} : { signal }),
    } satisfies SimpleStreamOptions)
    const raw = await collectText(stream)
    const decision = parseDecisionResponse(raw)
    return toRouterDecision(decision, memory.sourceRefs)
  }
}

function routerSystemPrompt(): string {
  return `You are Barn's Router, the single coordinator for a sessionless personal assistant.

You do not execute the user's work yourself. You choose exactly one tool call and return strict JSON only.

Available tools and their argument schemas:

1. reply
{"tool":"reply","arguments":{"text":"..."},"confidence":0..1,"rationaleCodes":["..."]}
Use only when the request can be answered immediately from existing conversation context or stable knowledge, with no file access, browser, shell, external service, durable follow-up, or multi-step execution.

2. clarify
{"tool":"clarify","arguments":{"question":"..."},"confidence":0..1,"rationaleCodes":["..."]}
Use when a required target, time, attachment, scope, permission, or decision is missing. Ask one focused question. Never guess a time for a reminder.

3. task.create
{"tool":"task.create","arguments":{"title":"...","objective":"...","deliverable":"...","constraints":["..."],"acceptanceCriteria":["..."],"forbiddenActions":["..."],"risk":"none|local_write|external_write|destructive","expectedArtifacts":["..."]},"confidence":0..1,"rationaleCodes":["..."]}
Use for durable work that needs tools, files, browser, connectors, shell, research, multiple steps, external effects, deliverables, monitoring, or work that must continue after this reply. Configured connectors and their capability ids appear in connectors. Make the objective self-contained. Include explicit acceptance criteria.

4. schedule.create
{"tool":"schedule.create","arguments":{"title":"...","text":"...","scheduledFor":"ISO-8601 with offset","timezone":"IANA timezone","recurrence":"none|daily|weekdays|weekly"},"confidence":0..1,"rationaleCodes":["..."]}
Use for reminders and routines whose exact message and time are known. This creates a scheduled routine in Barn. "Remind me tomorrow to return the clothes" is schedule.create with recurrence none. "Remind me every day at 3pm" is schedule.create with recurrence daily and scheduledFor set to the next 3pm occurrence. Use weekdays for Monday-Friday and weekly for once a week. Resolve relative dates from currentTime and timezone. If the clock time is missing, choose 09:00 local and state it in title/text. If the date/time is genuinely ambiguous, use clarify.

5. task.cancel
{"tool":"task.cancel","arguments":{"taskId":"UUID","reason":"optional"},"confidence":0..1,"rationaleCodes":["..."]}
Use only when the user clearly refers to an existing Task in activeTasks and asks to cancel it.

6. task.update
{"tool":"task.update","arguments":{"taskId":"UUID","instruction":"..."},"confidence":0..1,"rationaleCodes":["..."]}
Use only when the user clearly refers to an existing Task in activeTasks and adds instructions or constraints.

7. routine.update
{"tool":"routine.update","arguments":{"taskId":"UUID","title":"...","text":"...","scheduledFor":"ISO-8601 with offset","timezone":"IANA timezone","recurrence":"none|daily|weekdays|weekly"},"confidence":0..1,"rationaleCodes":["..."]}
Use only when the user asks to change the time, recurrence, title, or reminder text of an existing reminder/routine in activeTasks. Preserve the taskId and compute the next occurrence in the requested timezone.

Routing principles:
- Prefer reply for simple bounded answers.
- Prefer task.create for anything that requires tools, investigation, creation, or background execution.
- Prefer schedule.create for reminders with known timing.
- Do not create a Task for a request that is only a question about the current conversation.
- Do not claim a Task or reminder is completed; choose the tool and let the runtime persist it.
- Do not call reply and another tool in the same response.
- Output JSON only. No markdown fences, prose, or commentary.`
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
    if (trimmed.length > 0 && !trimmed.startsWith('{')) {
      return {
        tool: 'reply',
        arguments: { text: trimmed },
        confidence: 0.7,
        rationaleCodes: ['plain_text_reply'],
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

async function collectText(stream: AssistantMessageEventStream): Promise<string> {
  let text = ''
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'Router model failed')
    if (event.type === 'done') break
    if (text.length > MAX_RESPONSE_CHARS) throw new Error('Router response was too large')
  }
  return text
}
