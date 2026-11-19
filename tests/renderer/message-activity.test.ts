import { describe, expect, it } from 'vitest'
import type { RouterRequest, Task, TaskStatus } from '../../src/shared/models'
import { resolveMessageActivity } from '../../src/renderer/message-activity'

function task(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status,
    origin: 'user',
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

function request(id: string, sequence: number, status: RouterRequest['status']): RouterRequest {
  return {
    id,
    threadId: 'thread',
    userMessageId: `message-${id}`,
    sequence,
    priority: 0,
    status,
    attemptCount: 0,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
  }
}

describe('resolveMessageActivity', () => {
  it('prioritizes the latest Router request over running tasks', () => {
    const activity = resolveMessageActivity(
      [request('newer', 2, 'queued'), request('older', 1, 'routing')],
      [task('background', 'running')],
      false,
    )

    expect(activity).toMatchObject({ kind: 'query', id: 'request:newer' })
  })

  it('falls back to a running task after the latest question finishes', () => {
    const activity = resolveMessageActivity(
      [request('question', 1, 'completed')],
      [task('queued', 'queued'), task('running', 'running')],
      false,
    )

    expect(activity).toMatchObject({
      kind: 'task',
      id: 'task:running',
      task: expect.objectContaining({ id: 'running' }),
      activeTaskCount: 2,
    })
  })

  it('renders nothing when no question or task is executing', () => {
    expect(resolveMessageActivity([], [], false)).toBeUndefined()
    expect(resolveMessageActivity([], [task('waiting', 'waiting')], false)).toBeUndefined()
  })

  it('never treats reminder routines as Thinking Orbs task activity', () => {
    const now = Date.parse('2026-11-19T08:00:00.000Z')
    expect(resolveMessageActivity([], [
      task('running-reminder', 'running', { kind: 'reminder' }),
      task('queued-reminder', 'queued', { kind: 'reminder', scheduledFor: '2026-11-19T07:00:00.000Z' }),
    ], false, now)).toBeUndefined()
  })

  it('does not treat a future scheduled reminder as executing work', () => {
    const now = Date.parse('2026-11-18T08:00:00.000Z')
    const activity = resolveMessageActivity(
      [],
      [task('reminder', 'queued', { scheduledFor: '2026-11-19T01:00:00.000Z', kind: 'reminder' })],
      false,
      now,
    )

    expect(activity).toBeUndefined()
  })

  it('shows query activity while the Router is pending before request state arrives', () => {
    expect(resolveMessageActivity([], [], true)).toMatchObject({ kind: 'query', id: 'query:pending' })
  })
})
