import type { ActionRecord } from '../actions/types'
import type { TaskService } from './task-service'

type TaskActions = {
  onChange(listener: (action: ActionRecord) => void): () => void
}

type Tasks = Pick<TaskService, 'get' | 'recordResult' | 'updateStatus'>

/**
 * Settles the Task that owns a terminal external Action. Permission resolution
 * only records the person's decision; the effect owner decides whether the Task
 * completed, failed, or needs a person to inspect an unknown outcome.
 */
export class TaskActionCoordinator {
  private dispose: (() => void) | undefined

  constructor(
    private readonly tasks: Tasks,
    private readonly actions: TaskActions,
  ) {}

  start(): void {
    if (this.dispose !== undefined) return
    this.dispose = this.actions.onChange((action) => this.reconcile(action))
  }

  stop(): void {
    this.dispose?.()
    this.dispose = undefined
  }

  private reconcile(action: ActionRecord): void {
    if (action.taskId === undefined) return
    let task
    try {
      task = this.tasks.get(action.taskId)
    } catch {
      // The Task may have been removed after the Action was admitted.
      return
    }
    if (task.status !== 'waiting') return
    if (task.approvalId !== undefined && action.approvalId !== task.approvalId) return

    if (action.status === 'succeeded') {
      const result = task.result ?? {
        outcome: 'completed' as const,
        summary: action.summary,
        artifacts: [],
        evidenceRefs: [],
        limitations: [],
        externalEffectReceipts: [],
      }
      const receipt = `action:${action.id}:succeeded`
      this.tasks.recordResult(task.id, {
        ...result,
        outcome: 'completed',
        externalEffectReceipts: result.externalEffectReceipts.includes(receipt)
          ? result.externalEffectReceipts
          : [...result.externalEffectReceipts, receipt],
      })
      return
    }

    if (action.status === 'cancelled') {
      this.tasks.updateStatus(task.id, {
        status: 'cancelled',
        detail: action.lastError ?? 'The external action was cancelled.',
      })
      return
    }

    if (action.status === 'failed' && action.nextAttemptAt === undefined) {
      const result = task.result ?? {
        outcome: 'failed' as const,
        summary: action.summary,
        artifacts: [],
        evidenceRefs: [],
        limitations: [],
        externalEffectReceipts: [],
      }
      const failure = action.lastError ?? 'The external action failed.'
      this.tasks.recordResult(task.id, {
        ...result,
        outcome: 'failed',
        summary: result.summary,
        limitations: result.limitations.includes(failure)
          ? result.limitations
          : [...result.limitations, failure],
        externalEffectReceipts: result.externalEffectReceipts.includes(`action:${action.id}:failed`)
          ? result.externalEffectReceipts
          : [...result.externalEffectReceipts, `action:${action.id}:failed`],
      })
      return
    }

    if (action.status === 'unknown_effect') {
      const result = task.result ?? {
        outcome: 'needs_review' as const,
        summary: action.summary,
        artifacts: [],
        evidenceRefs: [],
        limitations: [],
        externalEffectReceipts: [],
      }
      const limitation = action.lastError
        ?? 'The external action may have run. Inspect the destination before retrying.'
      this.tasks.recordResult(task.id, {
        ...result,
        outcome: 'needs_review',
        limitations: result.limitations.includes(limitation)
          ? result.limitations
          : [...result.limitations, limitation],
        externalEffectReceipts: result.externalEffectReceipts.includes(`action:${action.id}:unknown_effect`)
          ? result.externalEffectReceipts
          : [...result.externalEffectReceipts, `action:${action.id}:unknown_effect`],
      })
    }
  }
}
