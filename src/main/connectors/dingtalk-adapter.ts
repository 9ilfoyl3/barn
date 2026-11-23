import { z } from 'zod'
import type { ConnectorCapabilityDefinition } from '../../shared/models'
import type { ConnectorAdapter, ConnectorExecutionContext } from './types'
import type { DingTalkRuntimeClient } from './dingtalk-runtime'

const searchContactArgsSchema = z.object({
  query: z.string().trim().min(1).max(200),
}).strict()

const calendarListArgsSchema = z.object({
  start: z.string().trim().min(1).max(80).optional(),
  end: z.string().trim().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict()

const todoListArgsSchema = z.object({
  page: z.number().int().min(1).max(10_000).default(1),
  size: z.number().int().min(1).max(100).default(20),
}).strict()

const chatSearchArgsSchema = z.object({
  query: z.string().trim().min(1).max(500),
  conversationId: z.string().trim().min(1).max(500).optional(),
  start: z.string().trim().min(1).max(80).optional(),
  end: z.string().trim().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict()

const messageListArgsSchema = z.object({
  conversationId: z.string().trim().min(1).max(500).optional(),
  userId: z.string().trim().min(1).max(200).optional(),
  openDingTalkId: z.string().trim().min(1).max(500).optional(),
  time: z.string().trim().min(1).max(80).optional(),
  direction: z.enum(['newer', 'older']).default('older'),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().refine((value) => (
  [value.conversationId, value.userId, value.openDingTalkId].filter((target) => target !== undefined).length === 1
), {
  message: 'Provide exactly one DingTalk target: conversationId, userId, or openDingTalkId',
})

const sendMessageArgsSchema = z.object({
  conversationId: z.string().trim().min(1).max(500).optional(),
  userId: z.string().trim().min(1).max(200).optional(),
  openDingTalkId: z.string().trim().min(1).max(500).optional(),
  content: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(200).optional(),
}).strict().refine((value) => (
  [value.conversationId, value.userId, value.openDingTalkId].filter((target) => target !== undefined).length === 1
), {
  message: 'Provide exactly one DingTalk target: conversationId, userId, or openDingTalkId',
})

export class DingTalkConnectorAdapter implements ConnectorAdapter {
  readonly kind = 'dingtalk'

  constructor(private readonly runtime: DingTalkRuntimeClient) {}

  async test(_context: ConnectorExecutionContext): Promise<{ message: string }> {
    const status = await this.runtime.status()
    if (!status.installed) throw new Error('DingTalk support is not installed')
    if (!status.authenticated) throw new Error('Sign in to DingTalk first')
    const identity = [status.userName, status.organization].filter((value) => value !== undefined).join(' · ')
    return { message: identity.length > 0 ? `Connected to DingTalk as ${identity}` : 'Connected to DingTalk' }
  }

  async call(
    context: ConnectorExecutionContext,
    capability: ConnectorCapabilityDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (capability.id) {
      case 'dingtalk.contactSearch': {
        const input = searchContactArgsSchema.parse(args)
        return this.runtime.runJson([
          'contact', 'user', 'search',
          '--query', input.query,
          '--format', 'json',
        ], context.signal)
      }
      case 'dingtalk.calendarList': {
        const input = calendarListArgsSchema.parse(args)
        return this.runtime.runJson([
          'calendar', 'event', 'list',
          ...(input.start === undefined ? [] : ['--start', input.start]),
          ...(input.end === undefined ? [] : ['--end', input.end]),
          '--limit', String(input.limit),
          '--format', 'json',
        ], context.signal)
      }
      case 'dingtalk.todoList': {
        const input = todoListArgsSchema.parse(args)
        return this.runtime.runJson([
          'todo', 'task', 'list',
          '--page', String(input.page),
          '--size', String(input.size),
          '--format', 'json',
        ], context.signal)
      }
      case 'dingtalk.chatSearch': {
        const input = chatSearchArgsSchema.parse(args)
        return this.runtime.runJson([
          'chat', 'message', 'search',
          '--query', input.query,
          ...(input.conversationId === undefined ? [] : ['--conversation-id', input.conversationId]),
          ...(input.start === undefined ? [] : ['--start', input.start]),
          ...(input.end === undefined ? [] : ['--end', input.end]),
          '--limit', String(input.limit),
          '--format', 'json',
        ], context.signal)
      }
      case 'dingtalk.messageList': {
        const input = messageListArgsSchema.parse(args)
        return this.runtime.runJson([
          'chat', 'message', 'list',
          ...(input.conversationId === undefined ? [] : ['--group', input.conversationId]),
          ...(input.userId === undefined ? [] : ['--user', input.userId]),
          ...(input.openDingTalkId === undefined ? [] : ['--open-dingtalk-id', input.openDingTalkId]),
          ...(input.time === undefined ? [] : ['--time', input.time]),
          '--direction', input.direction,
          '--limit', String(input.limit),
          '--format', 'json',
        ], context.signal)
      }
      case 'dingtalk.send': {
        const input = sendMessageArgsSchema.parse(args)
        return this.runtime.runJson([
          'chat', 'message', 'send',
          ...(input.conversationId === undefined ? [] : ['--group', input.conversationId]),
          ...(input.userId === undefined ? [] : ['--user', input.userId]),
          ...(input.openDingTalkId === undefined ? [] : ['--open-dingtalk-id', input.openDingTalkId]),
          ...(input.title === undefined ? [] : ['--title', input.title]),
          '--content', input.content,
          '--format', 'json',
          '--yes',
        ], context.signal)
      }
      default:
        throw new Error(`Unknown DingTalk capability: ${capability.id}`)
    }
  }
}
