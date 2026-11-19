import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/renderer/conversation'
import { groupConversationMessages } from '../../src/renderer/conversation'

function message(
  key: string,
  role: ChatMessage['role'],
  text: string,
  routerRequestId?: string,
  routineDelivery = false,
): ChatMessage {
  return {
    key,
    role,
    parts: [{ type: 'text', text }],
    attachments: [],
    isError: false,
    ...(routerRequestId === undefined ? {} : { routerRequestId }),
    ...(routineDelivery ? { routineDelivery: true } : {}),
  }
}

describe('groupConversationMessages', () => {
  it('keeps consecutive assistant replies in one guided group and quotes their user messages', () => {
    const groups = groupConversationMessages([
      message('u1', 'user', 'Check Shanghai weather', 'r1'),
      message('u2', 'user', 'Check Nanjing weather', 'r2'),
      message('a1', 'assistant', 'Shanghai is cold.', 'r1'),
      message('a2', 'assistant', 'Nanjing is colder.', 'r2'),
    ])

    expect(groups.map((group) => group.kind)).toEqual(['user', 'user', 'assistant'])
    const assistant = groups[2]
    expect(assistant).toMatchObject({
      kind: 'assistant',
      replies: [
        { message: { key: 'a1' } },
        { message: { key: 'a2' }, quotedUser: { key: 'u2' } },
      ],
    })
  })

  it('does not quote an immediately preceding user message for a single reply', () => {
    const groups = groupConversationMessages([
      message('u1', 'user', 'One', 'r1'),
      message('a1', 'assistant', 'Answer one', 'r1'),
      message('u2', 'user', 'Two', 'r2'),
      message('a2', 'assistant', 'Answer two', 'r2'),
    ])

    expect(groups).toHaveLength(4)
    expect(groups[1]).toMatchObject({ kind: 'assistant', replies: [{ message: { key: 'a1' } }] })
    expect(groups[3]).toMatchObject({ kind: 'assistant', replies: [{ message: { key: 'a2' } }] })
    expect((groups[1] as { replies: Array<{ quotedUser?: ChatMessage }> }).replies[0]?.quotedUser).toBeUndefined()
    expect((groups[3] as { replies: Array<{ quotedUser?: ChatMessage }> }).replies[0]?.quotedUser).toBeUndefined()
  })

  it('keeps proactive routine deliveries outside guided reply groups', () => {
    const groups = groupConversationMessages([
      message('u1', 'user', 'Remind me', 'r1'),
      message('a1', 'assistant', 'I will remind you.', 'r1'),
      message('routine', 'assistant', 'Reminder: bring the clothes.', undefined, true),
      message('a2', 'assistant', 'A normal reply.', 'r2'),
    ])

    expect(groups.map((group) => group.kind)).toEqual(['user', 'assistant', 'proactive', 'assistant'])
    expect(groups[2]).toMatchObject({ kind: 'proactive', message: { key: 'routine' } })
  })

  it('falls back to the nearest user message when metadata is missing', () => {
    const groups = groupConversationMessages([
      message('u1', 'user', 'Nearest user'),
      message('a1', 'assistant', 'Answer'),
    ])

    expect(groups[1]).toMatchObject({
      kind: 'assistant',
      replies: [{ message: { key: 'a1' } }],
    })
  })
})
