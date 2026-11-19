import { describe, expect, it } from 'vitest'
import type { Task, TaskStatus } from '../../src/shared/models'
import { defaultTaskRailFilter, filterTasksForRail } from '../../src/renderer/TaskRail'

function task(id: string, status: TaskStatus, updatedAt = '2026-11-18T00:00:00.000Z'): Task {
  return {
    id,
    title: id,
    status,
    origin: 'user',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt,
  }
}

describe('task rail filters', () => {
  it('groups all four home status filters, including cancelled tasks', () => {
    const tasks = [
      task('waiting', 'waiting'),
      task('proposed', 'proposed'),
      task('running', 'running'),
      task('queued', 'queued'),
      task('completed', 'completed'),
      task('failed', 'failed'),
      task('cancelled', 'cancelled'),
    ]

    expect(filterTasksForRail(tasks, 'review').map((item) => item.id)).toEqual(['waiting', 'proposed', 'failed'])
    expect(filterTasksForRail(tasks, 'active').map((item) => item.id)).toEqual(['running', 'queued'])
    expect(filterTasksForRail(tasks, 'completed').map((item) => item.id)).toEqual(['completed'])
    expect(filterTasksForRail(tasks, 'cancelled').map((item) => item.id)).toEqual(['cancelled'])
  })

  it('opens on the first filter that has work', () => {
    expect(defaultTaskRailFilter([])).toBe('active')
    expect(defaultTaskRailFilter([task('completed', 'completed')])).toBe('completed')
    expect(defaultTaskRailFilter([
      task('completed', 'completed'),
      task('waiting', 'waiting'),
    ])).toBe('review')
  })

  it('sorts equal-status tasks by most recently updated first', () => {
    const tasks = [
      task('older', 'completed', '2026-11-17T00:00:00.000Z'),
      task('newer', 'completed', '2026-11-18T00:00:00.000Z'),
    ]

    expect(filterTasksForRail(tasks, 'completed').map((item) => item.id)).toEqual(['newer', 'older'])
  })
})
