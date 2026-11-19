import type { RouterRequest, Task } from '../shared/models'

export type MessageActivity =
  | {
      kind: 'query'
      id: string
      request?: RouterRequest
    }
  | {
      kind: 'task'
      id: string
      task: Task
      activeTaskCount: number
    }

const ACTIVE_REQUEST_STATUSES = new Set<RouterRequest['status']>(['queued', 'routing'])

/** Resolve the one activity that owns the conversation waiting indicator. */
export function resolveMessageActivity(
  requests: RouterRequest[],
  tasks: Task[],
  pending: boolean,
  now = Date.now(),
): MessageActivity | undefined {
  const latestRequest = requests.reduce<RouterRequest | undefined>(
    (latest, request) => latest === undefined || request.sequence > latest.sequence ? request : latest,
    undefined,
  )

  if (latestRequest !== undefined && ACTIVE_REQUEST_STATUSES.has(latestRequest.status)) {
    return { kind: 'query', id: `request:${latestRequest.id}`, request: latestRequest }
  }
  if (pending) return { kind: 'query', id: 'query:pending' }

  const activeTasks = tasks
    .filter((task) => task.kind !== 'reminder' && isExecutingTask(task, now))
    .toSorted((left, right) => activityRank(left.status) - activityRank(right.status) || right.updatedAt.localeCompare(left.updatedAt))
  const task = activeTasks[0]
  if (task === undefined) return undefined
  return {
    kind: 'task',
    id: `task:${task.id}`,
    task,
    activeTaskCount: activeTasks.length,
  }
}

export function isExecutingTask(task: Task, now = Date.now()): boolean {
  if (task.status === 'running') return true
  if (task.status !== 'queued') return false
  if (task.scheduledFor === undefined) return true
  const dueAt = Date.parse(task.scheduledFor)
  return Number.isNaN(dueAt) || dueAt <= now
}

function activityRank(status: Task['status']): number {
  if (status === 'running') return 0
  if (status === 'queued') return 1
  return 2
}
