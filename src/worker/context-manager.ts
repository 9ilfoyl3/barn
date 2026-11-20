import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate'

export interface ContextManagerOptions {
  contextWindow: number
  maxOutputTokens: number
}

export interface ContextTransformResult {
  messages: AgentMessage[]
  tokens: number
  budget: number
  compacted: boolean
}

export class ContextManager {
  readonly budget: number

  constructor(private readonly options: ContextManagerOptions) {
    const reserved = Math.max(
      4_096,
      Math.min(options.maxOutputTokens, Math.floor(options.contextWindow * 0.3)),
    )
    this.budget = Math.max(4_096, options.contextWindow - reserved)
  }

  transform(messages: AgentMessage[]): ContextTransformResult {
    if (messages.length === 0) {
      return { messages, tokens: 0, budget: this.budget, compacted: false }
    }

    const leadingSystemCount = countLeadingSystemMessages(messages)
    const head = messages.slice(0, leadingSystemCount)
    const userIndexes = messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
    let best = messages
    let bestTokens = estimateMessages(messages)

    for (const keepTurns of [4, 3, 2, 1]) {
      const candidate = buildCandidate(messages, head, userIndexes, keepTurns)
      const tokens = estimateMessages(candidate)
      if (tokens < bestTokens) {
        best = candidate
        bestTokens = tokens
      }
      if (tokens <= this.budget) {
        return {
          messages: candidate,
          tokens,
          budget: this.budget,
          compacted: candidate !== messages,
        }
      }
    }

    let compacted = compactTail(best, 8_000)
    let tokens = estimateMessages(compacted)
    if (tokens <= this.budget) {
      return { messages: compacted, tokens, budget: this.budget, compacted: true }
    }

    compacted = compactTail(compacted, 3_000)
    tokens = estimateMessages(compacted)
    if (tokens <= this.budget) {
      return { messages: compacted, tokens, budget: this.budget, compacted: true }
    }

    const emergency = emergencyTrim(compacted, 12_000)
    return {
      messages: emergency,
      tokens: estimateMessages(emergency),
      budget: this.budget,
      compacted: true,
    }
  }
}

function buildCandidate(
  messages: AgentMessage[],
  head: AgentMessage[],
  userIndexes: number[],
  keepTurns: number,
): AgentMessage[] {
  if (userIndexes.length <= keepTurns) return messages
  const tailStart = userIndexes[userIndexes.length - keepTurns]
  if (tailStart === undefined) return messages
  const dropped = messages.slice(head.length, tailStart)
  if (dropped.length === 0) return messages
  const tail = messages.slice(tailStart)
  return [
    ...head,
    checkpointMessage(dropped),
    ...tail,
  ]
}

function checkpointMessage(dropped: AgentMessage[]): AgentMessage {
  const toolNames = new Set<string>()
  let userTurns = 0
  let assistantMessages = 0
  let firstSeq: number | undefined
  let lastSeq: number | undefined
  for (const message of dropped) {
    const seq = messageSeq(message)
    if (seq !== undefined) {
      firstSeq = firstSeq === undefined ? seq : Math.min(firstSeq, seq)
      lastSeq = lastSeq === undefined ? seq : Math.max(lastSeq, seq)
    }
    if (message.role === 'user') userTurns++
    if (message.role === 'assistant') {
      assistantMessages++
      for (const block of message.content) {
        if (block.type === 'toolCall') toolNames.add(block.name)
      }
    }
  }
  const tools = [...toolNames].toSorted()
  const userHighlights = dropped
    .filter((message) => message.role === 'user')
    .flatMap((message) => [messageText(message)])
    .filter((text) => text.trim().length > 0)
    .slice(-2)
    .map((text) => truncateMiddle(text.trim(), 1_200))
  const assistantHighlights = dropped
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => [messageText(message)])
    .filter((text) => text.trim().length > 0)
    .slice(-2)
    .map((text) => truncateMiddle(text.trim(), 1_200))
  const toolIssues = dropped
    .filter((message) => message.role === 'toolResult')
    .filter((message) => message.isError || /error|failed|denied|not found|timed out/iu.test(messageText(message)))
    .slice(-2)
    .map((message) => truncateMiddle(messageText(message).trim(), 800))
  const range = firstSeq === undefined || lastSeq === undefined
    ? 'The original transcript remains in this Session.'
    : `Exact transcript range: seq ${firstSeq}-${lastSeq}. Call session_history with startSeq=${firstSeq} and endSeq=${lastSeq} to retrieve omitted details.`
  return {
    role: 'system',
    content: [
      '[Barn context checkpoint]',
      `Earlier history compacted: ${dropped.length} messages, ${userTurns} user turns, ${assistantMessages} assistant messages.`,
      range,
      tools.length === 0 ? 'No earlier tools were recorded.' : `Earlier tools: ${tools.join(', ')}.`,
      ...(userHighlights.length === 0 ? [] : ['Earlier user requests:', ...userHighlights.map((text) => `- ${text}`)]),
      ...(assistantHighlights.length === 0 ? [] : ['Earlier assistant conclusions:', ...assistantHighlights.map((text) => `- ${text}`)]),
      ...(toolIssues.length === 0 ? [] : ['Earlier tool issues:', ...toolIssues.map((text) => `- ${text}`)]),
      'The checkpoint is lossy. Use session_history before relying on omitted details.',
    ].join('\n'),
    timestamp: Date.now(),
  }
}

function compactTail(messages: AgentMessage[], maxChars: number): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === 'toolResult') {
      const text = messageText(message)
      return {
        ...message,
        content: [{
          type: 'text',
          text: truncateMiddle(text, maxChars, 'tool result'),
        }],
      }
    }
    if (message.role === 'assistant') {
      return {
        ...message,
        content: message.content.flatMap((block) => {
          if (block.type === 'thinking') return []
          if (block.type === 'text' && block.text.length > maxChars) {
            return [{ ...block, text: truncateMiddle(block.text, maxChars, 'assistant text') }]
          }
          return [block]
        }),
      }
    }
    return message
  })
}

function emergencyTrim(messages: AgentMessage[], maxUserChars: number): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return message
    return message.content.length <= maxUserChars
      ? message
      : {
        ...message,
        content: truncateMiddle(message.content, maxUserChars, 'user message'),
      }
  })
}

function truncateMiddle(value: string, maxChars: number, label = 'content'): string {
  if (value.length <= maxChars) return value
  const marker = `\n\n[${label} middle omitted to fit context. Use session_history for the full text.]\n\n`
  const available = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(available * 0.62)
  const tail = Math.max(0, available - head)
  return `${value.slice(0, head)}${marker}${tail === 0 ? '' : value.slice(-tail)}`
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    return []
  }).join('\n')
}

function messageSeq(message: AgentMessage): number | undefined {
  const seq = (message as AgentMessage & { barnSeq?: unknown }).barnSeq
  return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? seq : undefined
}

function countLeadingSystemMessages(messages: AgentMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role !== 'system') break
    count++
  }
  return count
}

function estimateMessages(messages: AgentMessage[]): number {
  return estimateContextTokens(messages as unknown as Message[]).tokens
}
