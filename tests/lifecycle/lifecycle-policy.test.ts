import { describe, expect, it } from 'vitest'
import type { Task } from '../../src/shared/models'
import {
  isActionableTaskStatus,
  shouldNotifyTask,
  shouldResumeAfterNetwork,
  supportsLaunchAtLogin,
  taskNotificationSignature,
} from '../../src/main/lifecycle/lifecycle-policy'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Review the report',
    status: 'proposed',
    origin: 'automation',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('lifecycle policy', () => {
  it('notifies only actionable tasks while the window is unfocused and only once per update', () => {
    const proposed = task()
    expect(isActionableTaskStatus('proposed')).toBe(true)
    expect(isActionableTaskStatus('waiting')).toBe(true)
    expect(isActionableTaskStatus('failed')).toBe(true)
    expect(isActionableTaskStatus('running')).toBe(false)
    expect(isActionableTaskStatus('completed')).toBe(false)
    expect(shouldNotifyTask(proposed, false, undefined)).toBe(true)
    expect(shouldNotifyTask(proposed, true, undefined)).toBe(false)
    expect(shouldNotifyTask(proposed, false, taskNotificationSignature(proposed))).toBe(false)
    expect(shouldNotifyTask({ ...proposed, status: 'completed' }, false, undefined)).toBe(false)
  })

  it('recovers only on an offline-to-online transition', () => {
    expect(shouldResumeAfterNetwork(false, true)).toBe(true)
    expect(shouldResumeAfterNetwork(true, true)).toBe(false)
    expect(shouldResumeAfterNetwork(true, false)).toBe(false)
  })

  it('offers launch at login only on supported desktop platforms', () => {
    expect(supportsLaunchAtLogin('darwin')).toBe(true)
    expect(supportsLaunchAtLogin('win32')).toBe(true)
    expect(supportsLaunchAtLogin('linux')).toBe(false)
  })
})
