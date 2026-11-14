import type { Task, TaskStatus } from '../../shared/models'

const ACTIONABLE = new Set<TaskStatus>(['proposed', 'waiting', 'failed'])

export function isActionableTaskStatus(status: TaskStatus): boolean {
  return ACTIONABLE.has(status)
}

export function taskNotificationSignature(task: Task): string {
  return `${task.id}:${task.status}:${task.updatedAt}`
}

export function shouldNotifyTask(
  task: Task,
  windowFocused: boolean,
  lastSignature: string | undefined,
): boolean {
  return !windowFocused
    && isActionableTaskStatus(task.status)
    && lastSignature !== taskNotificationSignature(task)
}

export function shouldResumeAfterNetwork(previousOnline: boolean, currentOnline: boolean): boolean {
  return !previousOnline && currentOnline
}

export function supportsLaunchAtLogin(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}
