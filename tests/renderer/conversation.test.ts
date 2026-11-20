import { describe, expect, it } from 'vitest'
import type { SessionLiveEvent, SessionTimelineEvent } from '../../src/shared/models'
import { applyLiveEvent, chatMessagesFromThread, conversationRenderEntries, groupConversationParts, messagesFromEvents, parseVisibleResultCard } from '../../src/renderer/conversation'

describe('conversation timeline', () => {
  it('rebuilds thinking, tool and content in persisted event order', () => {
    const events: SessionTimelineEvent[] = [
      timelineEvent('event-user', 1, {
        message: { role: 'user', content: 'Inspect the file' },
      }),
      timelineEvent('event-assistant-tool', 2, {
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should inspect the workspace.' },
            { type: 'toolCall', id: 'call-shell', name: 'shell', arguments: { command: 'ls' } },
            { type: 'text', text: 'I will run the command first.' },
          ],
        },
      }),
      timelineEvent('event-tool-result', 3, {
        message: {
          role: 'toolResult',
          toolCallId: 'call-shell',
          content: [{ type: 'text', text: 'file.txt' }],
          isError: false,
        },
      }),
      timelineEvent('event-assistant-final', 4, {
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'The result is clear.' },
            { type: 'text', text: 'The file contains **file.txt**.' },
          ],
        },
      }),
    ]

    const assistant = messagesFromEvents(events)[1]
    expect(assistant?.parts.map((part) => part.type)).toEqual([
      'thinking',
      'tool',
      'text',
      'thinking',
      'text',
    ])
    const tool = assistant?.parts.find((part) => part.type === 'tool')
    expect(tool).toMatchObject({
      tool: {
        id: 'call-shell',
        name: 'shell',
        status: 'success',
        output: 'file.txt',
      },
    })
  })

  it('keeps Task results at their original timeline position', () => {
    const entries = conversationRenderEntries([
      {
        key: 'result-1',
        role: 'assistant',
        taskResult: true,
        parts: [{ type: 'text', text: 'First result' }],
        attachments: [],
        isError: false,
      },
      {
        key: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Next request' }],
        attachments: [],
        isError: false,
      },
      {
        key: 'reply-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Answer' }],
        attachments: [],
        isError: false,
      },
      {
        key: 'result-2',
        role: 'assistant',
        taskResult: true,
        parts: [{ type: 'text', text: 'Second result' }],
        attachments: [],
        isError: false,
      },
    ])

    expect(entries.map((entry) => entry.kind === 'task-result' ? entry.message.key : entry.group.key)).toEqual([
      'result-1',
      'user:user-1',
      'assistant:reply-1',
      'result-2',
    ])
  })

  it('marks a Task result from the Principal Thread so it stays outside reply guides', () => {
    const messages = chatMessagesFromThread([{
      id: 'task-result',
      threadId: 'thread',
      seq: 1,
      role: 'assistant',
      content: 'The task finished.',
      metadata: { taskId: 'task-1', taskResult: true },
      sourceRefs: ['task:task-1'],
      createdAt: '2026-11-20T00:00:00.000Z',
    }])

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      taskId: 'task-1',
      taskResult: true,
    })
  })

  it('keeps Router and Worker turns distinct in a task session', () => {
    const events: SessionTimelineEvent[] = [
      timelineEvent('event-router', 1, {
        actorRole: 'router',
        message: { role: 'user', content: 'Summarize the project notes.' },
      }),
      timelineEvent('event-worker', 2, {
        actorRole: 'worker',
        message: { role: 'assistant', content: 'I will read the notes.' },
      }),
      timelineEvent('event-user', 3, {
        message: { role: 'user', content: 'Include the latest decisions.' },
      }),
      timelineEvent('event-worker-final', 4, {
        actorRole: 'worker',
        message: { role: 'assistant', content: 'The summary is ready.' },
      }),
    ]

    expect(messagesFromEvents(events)).toMatchObject([
      { role: 'assistant', actorRole: 'router', parts: [{ type: 'text', text: 'Summarize the project notes.' }] },
      { role: 'assistant', actorRole: 'worker', parts: [{ type: 'text', text: 'I will read the notes.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Include the latest decisions.' }] },
      { role: 'assistant', actorRole: 'worker', parts: [{ type: 'text', text: 'The summary is ready.' }] },
    ])
  })

  it('appends live events without moving existing segments', () => {
    let parts = applyLiveEvent([], liveEvent({ type: 'assistant.thinking', delta: 'I' }))
    parts = applyLiveEvent(parts, liveEvent({ type: 'assistant.thinking', delta: ' need context.' }))
    parts = applyLiveEvent(parts, liveEvent({
      type: 'tool.started',
      toolCallId: 'call-1',
      toolName: 'shell',
      arguments: '{"command":"ls"}',
    }))
    parts = applyLiveEvent(parts, liveEvent({
      type: 'tool.finished',
      toolCallId: 'call-1',
      toolName: 'shell',
      isError: false,
    }))
    parts = applyLiveEvent(parts, liveEvent({ type: 'assistant.thinking', delta: 'Now read it.' }))
    parts = applyLiveEvent(parts, liveEvent({ type: 'assistant.delta', delta: 'The file is ' }))
    parts = applyLiveEvent(parts, liveEvent({
      type: 'tool.started',
      toolCallId: 'call-2',
      toolName: 'read_file',
      arguments: '{"path":"roster.txt"}',
    }))
    parts = applyLiveEvent(parts, liveEvent({ type: 'assistant.delta', delta: 'a roster.' }))

    expect(parts.map((part) => part.type)).toEqual([
      'thinking',
      'tool',
      'thinking',
      'text',
      'tool',
      'text',
    ])
    expect(parts[0]).toMatchObject({ type: 'thinking', text: 'I need context.', streaming: false })
    expect(parts[1]).toMatchObject({ type: 'tool', tool: { id: 'call-1', status: 'success', arguments: '{"command":"ls"}' } })
    expect(parts[3]).toMatchObject({ type: 'text', text: 'The file is ', streaming: false })
    expect(parts[5]).toMatchObject({ type: 'text', text: 'a roster.', streaming: true })
  })

  it('hides synthetic abort errors while keeping partial text from a user stop', () => {
    const events: SessionTimelineEvent[] = [
      timelineEvent('event-user', 1, {
        message: { role: 'user', content: 'Explain the workflow' },
      }),
      timelineEvent('event-legacy-abort', 2, {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Request aborted' }], stopReason: 'error' },
      }),
      timelineEvent('event-partial-abort', 3, {
        message: { role: 'assistant', content: [{ type: 'text', text: 'The workflow starts by' }], stopReason: 'aborted' },
      }),
    ]

    const messages = messagesFromEvents(events)

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      isError: false,
      parts: [{ type: 'text', text: 'The workflow starts by' }],
    })
  })


  it('groups only consecutive tool calls into one display row', () => {
    const display = groupConversationParts([
      { type: 'thinking', text: 'Inspect first.' },
      { type: 'tool', tool: { id: 'tool-1', name: 'read_file', arguments: '{}', status: 'success' } },
      { type: 'tool', tool: { id: 'tool-2', name: 'shell', arguments: '{}', status: 'success' } },
      { type: 'text', text: 'Intermediate result.' },
      { type: 'tool', tool: { id: 'tool-3', name: 'list_dir', arguments: '{}', status: 'success' } },
    ])

    expect(display.map((part) => part.type)).toEqual(['thinking', 'tool-group', 'text', 'tool-group'])
    expect(display[1]).toMatchObject({
      type: 'tool-group',
      tools: [{ id: 'tool-1' }, { id: 'tool-2' }],
    })
    expect(display[3]).toMatchObject({
      type: 'tool-group',
      tools: [{ id: 'tool-3' }],
    })
  })

  it('updates a repeated tool start without duplicating its card', () => {
    let parts = applyLiveEvent([], liveEvent({
      type: 'tool.started',
      toolCallId: 'call-1',
      toolName: 'shell',
      arguments: '{"command":"ls"}',
    }))
    parts = applyLiveEvent(parts, liveEvent({
      type: 'tool.started',
      toolCallId: 'call-1',
      toolName: 'shell-v2',
      arguments: '{"command":"pwd"}',
    }))

    expect(parts).toEqual([{
      type: 'tool',
      tool: {
        id: 'call-1',
        name: 'shell-v2',
        arguments: '{"command":"pwd"}',
        status: 'running',
      },
    }])
  })

  it('accepts only allowlisted result-card metadata', () => {
    const card = parseVisibleResultCard({
      version: 1,
      kind: 'task',
      title: 'Review the Q4 planning note',
      description: 'One decision is still open.',
      provider: 'You',
      status: 'Waiting',
      meta: 'Updated recently',
      href: 'https://example.com/plan',
      image: {
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        alt: 'Planning note preview',
      },
    })

    expect(card).toEqual({
      version: 1,
      kind: 'task',
      title: 'Review the Q4 planning note',
      description: 'One decision is still open.',
      provider: 'You',
      status: 'Waiting',
      meta: 'Updated recently',
      href: 'https://example.com/plan',
      image: {
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        alt: 'Planning note preview',
      },
    })
    expect(parseVisibleResultCard({ ...card, kind: 'html' })).toBeUndefined()
    expect(parseVisibleResultCard({ ...card, title: '' })).toBeUndefined()
    expect(parseVisibleResultCard({ ...card, href: 'javascript:alert(1)' })).toMatchObject({ title: card?.title })
    expect(parseVisibleResultCard({ ...card, href: 'javascript:alert(1)' })).not.toHaveProperty('href')
    expect(parseVisibleResultCard({
      ...card,
      image: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', alt: 'Unsafe' },
    })).not.toHaveProperty('image')
  })

  it('maps the Principal Thread to the same visible chat structure', () => {
    const messages = chatMessagesFromThread([
      {
        id: 'm1',
        threadId: 'primary',
        seq: 1,
        role: 'user',
        content: 'Review the launch plan.',
        metadata: { attachmentNames: ['plan.pdf'] },
        sourceRefs: ['session:s:event:e1'],
        createdAt: '2026-11-17T00:00:00.000Z',
      },
      {
        id: 'm2',
        threadId: 'primary',
        seq: 2,
        role: 'assistant',
        content: 'The plan is ready.',
        metadata: {},
        sourceRefs: ['session:s:event:e2'],
        createdAt: '2026-11-17T00:00:01.000Z',
      },
      {
        id: 'm3',
        threadId: 'primary',
        seq: 3,
        role: 'system',
        content: 'Internal',
        metadata: {},
        sourceRefs: [],
        createdAt: '2026-11-17T00:00:02.000Z',
      },
    ])

    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'Review the launch plan.' }] }),
      expect.objectContaining({ role: 'assistant', parts: [{ type: 'text', text: 'The plan is ready.' }] }),
    ])
    expect(messages[0]?.attachments).toEqual([{ name: 'plan.pdf', path: 'plan.pdf', size: 0 }])
  })

})

function timelineEvent(eventId: string, seq: number, data: unknown): SessionTimelineEvent {
  return {
    sessionId: 'session-1',
    seq,
    eventId,
    type: 'agent.message',
    data,
    actor: { kind: 'agent', id: 'barn' },
    createdAt: new Date(0).toISOString(),
  }
}

type StreamingLiveEvent = Extract<SessionLiveEvent, {
  type: 'assistant.delta' | 'assistant.thinking' | 'tool.started' | 'tool.finished'
}>

type StreamingLiveEventInput = StreamingLiveEvent extends infer Event
  ? Event extends StreamingLiveEvent
    ? Omit<Event, 'sessionId' | 'runId'>
    : never
  : never

function liveEvent(event: StreamingLiveEventInput): SessionLiveEvent {
  return {
    ...event,
    sessionId: 'session-1',
    runId: 'run-1',
  } as SessionLiveEvent
}
