import type {
  ApprovalRequest,
  PermissionOutcome,
  PermissionPolicy,
  PermissionRequestInput,
} from '../../shared/models'
import type { TaskService } from '../tasks/task-service'
import { PermissionStore } from './permission-store'

/** Evaluates safety policy and keeps approval decisions outside model-controlled content. */
export interface ApprovalResolution {
  approval: ApprovalRequest
  decision: 'approved' | 'denied'
}

export class PermissionService {
  private readonly resolutionListeners = new Set<(resolution: ApprovalResolution) => void>()

  constructor(
    private readonly store: PermissionStore,
    private readonly tasks: Pick<TaskService, 'get' | 'requestApproval' | 'updateStatus'>,
  ) {}

  getPolicy(): PermissionPolicy {
    return this.store.getPolicy()
  }

  setPolicy(policy: PermissionPolicy): PermissionPolicy {
    return this.store.setPolicy(policy)
  }

  request(input: PermissionRequestInput): PermissionOutcome {
    const policy = this.store.getPolicy()
    const mode = modeFor(policy, input.kind)
    if (mode === 'allow') return { decision: 'allowed' }
    if (mode === 'deny') {
      return { decision: 'denied', reason: `${input.kind} is blocked by your safety settings.` }
    }
    const approval = this.store.createApproval(input)
    if (input.taskId !== undefined) {
      this.tasks.requestApproval(input.taskId, approval.id, input.summary)
    }
    return { decision: 'approval_required', approval }
  }

  listPending(): ApprovalRequest[] {
    return this.store.listPending()
  }

  get(approvalId: string): ApprovalRequest {
    return this.store.get(approvalId)
  }

  /** Only the trusted Desktop surface calls this; a task cannot approve its own request. */
  resolve(approvalId: string, decision: 'approved' | 'denied'): ApprovalRequest {
    const approval = this.store.resolve(approvalId, decision)
    if (approval.taskId !== undefined) {
      try {
        const task = this.tasks.get(approval.taskId)
        if (task.status === 'waiting' && task.approvalId === approval.id) {
          this.tasks.updateStatus(approval.taskId, decision === 'approved'
            ? { status: 'queued', detail: 'Approved by a person.' }
            : { status: 'cancelled', detail: 'Denied by a person.' })
        }
      } catch {
        // An approval remains a valid audit record even if its Task was deleted or finished elsewhere.
      }
    }
    for (const listener of this.resolutionListeners) listener({ approval, decision })
    return approval
  }

  onResolved(listener: (resolution: ApprovalResolution) => void): () => void {
    this.resolutionListeners.add(listener)
    return () => this.resolutionListeners.delete(listener)
  }
}

function modeFor(policy: PermissionPolicy, kind: PermissionRequestInput['kind']): PermissionPolicy[keyof PermissionPolicy] {
  switch (kind) {
    case 'local-read': return policy.localRead
    case 'workspace-write': return policy.workspaceWrite
    case 'external-write': return policy.externalWrite
    case 'destructive': return policy.destructive
  }
}
