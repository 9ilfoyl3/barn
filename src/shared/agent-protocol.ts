import { z } from 'zod'
import { REASONING_EFFORTS, type ModelDescriptor, type ModelSelection } from './models'

export const modelSelectionSchema: z.ZodType<ModelSelection> = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
})

export const modelDescriptorSchema: z.ZodType<ModelDescriptor> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  providerId: z.string().min(1),
  api: z.string().min(1),
  reasoning: z.boolean(),
  reasoningEfforts: z.array(z.enum(REASONING_EFFORTS)),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  input: z.array(z.enum(['text', 'image'])).min(1),
})

export const workerSessionSeedSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(z.unknown()),
  model: modelDescriptorSchema,
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
})

export type WorkerSessionSeed = z.infer<typeof workerSessionSeedSchema>

export const runStatusSchema = z.enum(['running', 'idle', 'failed', 'cancelled'])
export type RunStatus = z.infer<typeof runStatusSchema>

export const sessionUiEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assistant.delta'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('assistant.thinking'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('tool.started'),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal('tool.finished'),
    toolCallId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal('context.updated'),
    tokens: z.number().int().nonnegative(),
    budget: z.number().int().positive(),
    compacted: z.boolean(),
  }),
])

export type SessionUiEvent = z.infer<typeof sessionUiEventSchema>

export const toolExecutionResultSchema = z.object({
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  ])),
  details: z.unknown(),
  isError: z.boolean().optional(),
})

export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>

export const hostToWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('worker.initialize'),
    requestId: z.string().min(1),
  }),
  z.object({
    type: z.literal('session.open'),
    requestId: z.string().min(1),
    session: workerSessionSeedSchema,
  }),
  z.object({
    type: z.literal('session.prompt'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal('session.cancel'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('request.ok'),
    requestId: z.string().min(1),
    result: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('request.error'),
    requestId: z.string().min(1),
    error: z.string(),
  }),
  z.object({
    type: z.literal('model.event'),
    requestId: z.string().min(1),
    event: z.unknown(),
  }),
  z.object({
    type: z.literal('model.error'),
    requestId: z.string().min(1),
    error: z.string(),
  }),
  z.object({
    type: z.literal('shutdown'),
  }),
])

export type HostToWorkerMessage = z.infer<typeof hostToWorkerMessageSchema>
export type HostRequestMessage = Extract<
  HostToWorkerMessage,
  { requestId: string }
>
export type HostRequestInput = HostRequestMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, 'requestId'>
    : never
  : never

export const workerToHostMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('worker.ready'),
  }),
  z.object({
    type: z.literal('request.ok'),
    requestId: z.string().min(1),
    result: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('request.error'),
    requestId: z.string().min(1),
    error: z.string(),
  }),
  z.object({
    type: z.literal('session.append'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    message: z.unknown(),
  }),
  z.object({
    type: z.literal('session.event'),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    event: sessionUiEventSchema,
  }),
  z.object({
    type: z.literal('run.status'),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    status: runStatusSchema,
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('model.start'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    selection: modelSelectionSchema,
    context: z.unknown(),
    options: z.unknown(),
  }),
  z.object({
    type: z.literal('model.abort'),
    requestId: z.string().min(1),
  }),
  z.object({
    type: z.literal('tool.execute'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown(),
  }),
])

export type WorkerToHostMessage = z.infer<typeof workerToHostMessageSchema>
export type WorkerRequestMessage = Extract<
  WorkerToHostMessage,
  { requestId: string }
>
export type WorkerRequestInput = WorkerRequestMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, 'requestId'>
    : never
  : never

export function parseHostToWorkerMessage(value: unknown): HostToWorkerMessage {
  return hostToWorkerMessageSchema.parse(value)
}

export function parseWorkerToHostMessage(value: unknown): WorkerToHostMessage {
  return workerToHostMessageSchema.parse(value)
}
