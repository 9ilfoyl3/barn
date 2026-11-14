import { describe, expect, it } from 'vitest'
import type { Task, TaskStatus } from '../../src/shared/models'
import { groupTasks } from '../../src/renderer/TaskCenter'

function task(id: string, status: TaskStatus): Task {
  return {
    id,
    title: id,
    status,
    origin: 'user',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  }
}

describe('groupTasks', () => {
  it('separates attention, active, and recent work without reordering each group', () => {
    const groups = groupTasks([
      task('waiting', 'waiting'),
      task('running', 'running'),
      task('completed', 'completed'),
      task('proposed', 'proposed'),
      task('queued', 'queued'),
      task('failed', 'failed'),
      task('cancelled', 'cancelled'),
    ])

    expect(groups.needsYou.map((item) => item.id)).toEqual(['waiting', 'proposed', 'failed'])
    expect(groups.inProgress.map((item) => item.id)).toEqual(['running', 'queued'])
    expect(groups.recent.map((item) => item.id)).toEqual(['completed', 'cancelled'])
  })
})
