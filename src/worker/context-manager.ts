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
  for (const message of dropped) {
    if (message.role === 'user') userTurns++
    if (message.role === 'assistant') {
      assistantMessages++
      for (const block of message.content) {
        if (block.type === 'toolCall') toolNames.add(block.name)
      }
    }
  }
  const tools = [...toolNames].toSorted()
  return {
    role: 'system',
    content: [
      '[Barn context checkpoint]',
      `Earlier history compacted: ${dropped.length} messages, ${userTurns} user turns, ${assistantMessages} assistant messages.`,
      tools.length === 0 ? 'No earlier tools were recorded.' : `Earlier tools: ${tools.join(', ')}.`,
      'The complete encrypted transcript remains available outside the model window.',
    ].join('\n'),
    timestamp: Date.now(),
  }
}

function compactTail(messages: AgentMessage[], maxToolChars: number): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === 'toolResult') {
      const text = message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
      return {
        ...message,
        content: [{
          type: 'text',
          text: text.length <= maxToolChars
            ? text
            : `${text.slice(0, maxToolChars)}\n\n[tool result truncated to fit the model context]`,
        }],
      }
    }
    if (message.role === 'assistant') {
      return {
        ...message,
        content: message.content.flatMap((block) => {
          if (block.type === 'thinking') return []
          if (block.type === 'text' && block.text.length > maxToolChars) {
            return [{ ...block, text: `${block.text.slice(0, maxToolChars)}\n\n[older assistant text truncated]` }]
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
        content: `${message.content.slice(0, maxUserChars)}\n\n[user message truncated to fit the model context]`,
      }
  })
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
