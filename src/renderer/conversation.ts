import type {
  AttachmentDescriptor,
  SessionLiveEvent,
  SessionTimelineEvent,
} from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'

export interface ToolCallView {
  id: string
  name: string
  arguments: string
  status: 'running' | 'success' | 'error'
  output?: string
}

export type ConversationPart =
  | { type: 'thinking'; text: string; streaming?: boolean }
  | { type: 'text'; text: string; streaming?: boolean }
  | { type: 'tool'; tool: ToolCallView }

export interface ChatMessage {
  key: string
  role: 'user' | 'assistant'
  parts: ConversationPart[]
  attachments: AttachmentDescriptor[]
  isError: boolean
}

export type ConversationDisplayPart =
  | Exclude<ConversationPart, { type: 'tool' }>
  | { type: 'tool-group'; key: string; tools: ToolCallView[] }

export function groupConversationParts(parts: ConversationPart[]): ConversationDisplayPart[] {
  const grouped: ConversationDisplayPart[] = []
  let tools: ToolCallView[] = []

  const flushTools = (): void => {
    if (tools.length === 0) return
    grouped.push({ type: 'tool-group', key: tools[0]?.id ?? 'tools', tools })
    tools = []
  }

  for (const part of parts) {
    if (part.type === 'tool') {
      tools.push(part.tool)
      continue
    }
    flushTools()
    grouped.push(part)
  }
  flushTools()
  return grouped
}

export function applyLiveEvent(
  current: ConversationPart[],
  event: SessionLiveEvent,
): ConversationPart[] {
  if (event.type === 'assistant.thinking') {
    return appendStreamingText(current, 'thinking', event.delta)
  }
  if (event.type === 'assistant.delta') {
    return appendStreamingText(current, 'text', event.delta)
  }
  if (event.type === 'tool.started') {
    const existing = current.findIndex((part) => part.type === 'tool' && part.tool.id === event.toolCallId)
    if (existing >= 0) {
      return current.map((part, index) => index === existing && part.type === 'tool'
        ? { type: 'tool', tool: { ...part.tool, name: event.toolName, arguments: event.arguments } }
        : part)
    }
    return [
      ...completeActiveStream(current),
      {
        type: 'tool',
        tool: {
          id: event.toolCallId,
          name: event.toolName,
          arguments: event.arguments,
          status: 'running',
        },
      },
    ]
  }
  if (event.type === 'tool.finished') {
    return current.map((part) => part.type === 'tool' && part.tool.id === event.toolCallId
      ? {
          type: 'tool',
          tool: {
            ...part.tool,
            status: event.isError ? 'error' : 'success',
          },
        }
      : part)
  }
  return current
}

export function messagesFromEvents(events: SessionTimelineEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of events) {
    if (event.type !== 'agent.message' || !isRecord(event.data) || !isRecord(event.data.message)) continue
    const message = event.data.message
    if (message.role === 'user') {
      const rawText = contentText(message.content)
      const legacy = splitLegacyAttachments(rawText)
      const explicitAttachments = attachmentList(event.data.attachments)
      messages.push({
        key: event.eventId,
        role: 'user',
        parts: legacy.text.length === 0 ? [] : [{ type: 'text', text: legacy.text }],
        attachments: explicitAttachments.length > 0 ? explicitAttachments : legacy.attachments,
        isError: false,
      })
      continue
    }
    if (message.role === 'toolResult') {
      const target = messages.findLast((entry) => entry.role === 'assistant')
      if (target === undefined) continue
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      const part = target.parts.find((entry) => entry.type === 'tool' && entry.tool.id === toolCallId)
      if (part?.type === 'tool') {
        part.tool.status = message.isError === true ? 'error' : 'success'
        part.tool.output = contentText(message.content)
      }
      continue
    }
    if (message.role !== 'assistant') continue
    if (isCancelledAssistantMessage(message)) continue

    let target = messages.at(-1)
    if (target?.role !== 'assistant') {
      target = {
        key: event.eventId,
        role: 'assistant',
        parts: [],
        attachments: [],
        isError: false,
      }
      messages.push(target)
    }

    if (typeof message.content === 'string') {
      appendPersistedText(target.parts, 'text', message.content)
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!isRecord(item)) continue
        if (item.type === 'text' && typeof item.text === 'string') {
          appendPersistedText(target.parts, 'text', item.text)
        } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
          appendPersistedText(target.parts, 'thinking', item.thinking)
        } else if (item.type === 'toolCall' && typeof item.name === 'string') {
          target.parts.push({
            type: 'tool',
            tool: {
              id: typeof item.id === 'string' ? item.id : `${event.eventId}:${toolPartCount(target.parts)}`,
              name: item.name,
              arguments: isRecord(item.arguments) ? JSON.stringify(item.arguments) : '',
              status: 'running',
            },
          })
        }
      }
    }
    if (message.stopReason === 'error' || message.isError === true) target.isError = true
  }
  return messages
}

function appendStreamingText(
  current: ConversationPart[],
  type: 'thinking' | 'text',
  delta: string,
): ConversationPart[] {
  const completed = completeActiveStream(current)
  const last = completed.at(-1)
  if (last?.type === type) {
    completed[completed.length - 1] = {
      type,
      text: last.text + delta,
      streaming: true,
    }
  } else {
    completed.push({ type, text: delta, streaming: true })
  }
  return completed
}

function completeActiveStream(current: ConversationPart[]): ConversationPart[] {
  const last = current.at(-1)
  if (last === undefined || (last.type !== 'thinking' && last.type !== 'text') || last.streaming !== true) {
    return [...current]
  }
  return [
    ...current.slice(0, -1),
    { ...last, streaming: false },
  ]
}

function appendPersistedText(
  parts: ConversationPart[],
  type: 'thinking' | 'text',
  text: string,
): void {
  if (text.length === 0) return
  const last = parts.at(-1)
  if (last?.type === type) {
    last.text = last.text.length === 0 ? text : `${last.text}\n${text}`
    return
  }
  parts.push({ type, text })
}

function toolPartCount(parts: ConversationPart[]): number {
  return parts.filter((part) => part.type === 'tool').length
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((item) => {
    if (!isRecord(item)) return []
    if (item.type === 'text' && typeof item.text === 'string') return [item.text]
    if (item.type === 'image') return ['[image]']
    return []
  }).join('\n')
}

function isCancelledAssistantMessage(message: Record<string, unknown>): boolean {
  if (message.stopReason === 'error' && contentText(message.content).trim() === 'Request aborted') return true
  if (message.stopReason !== 'aborted') return false
  if (typeof message.content === 'string') return message.content.trim().length === 0
  return Array.isArray(message.content) && message.content.length === 0
}

function attachmentList(value: unknown): AttachmentDescriptor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): AttachmentDescriptor[] => isRecord(entry)
    && typeof entry.name === 'string'
    && typeof entry.path === 'string'
    && typeof entry.size === 'number'
    ? [{
        name: attachmentDisplayName({ name: entry.name, path: entry.path }),
        path: entry.path,
        size: entry.size,
        ...(entry.kind === 'file' || entry.kind === 'directory' ? { kind: entry.kind } : {}),
      }]
    : [])
}

function splitLegacyAttachments(value: string): {
  text: string
  attachments: AttachmentDescriptor[]
} {
  const marker = '\n\nAttached files:\n'
  const index = value.lastIndexOf(marker)
  if (index < 0) return { text: value, attachments: [] }
  const text = value.slice(0, index).trimEnd()
  const attachments = value.slice(index + marker.length).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .map((path) => ({
      name: attachmentDisplayName({ name: path, path }),
      path,
      size: 0,
    }))
  return attachments.length === 0 ? { text: value, attachments: [] } : { text, attachments }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
