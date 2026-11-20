export type ActionStatus = 'pending_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ActionRecord {
  id: string
  kind: string
  idempotencyKey: string
  title: string
  summary: string
  details?: string
  status: ActionStatus
  taskId?: string
  approvalId?: string
  payload: unknown
  attempts: number
  maxAttempts: number
  nextAttemptAt?: string
  lastError?: string
  result?: unknown
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ActionRequestInput {
  kind: string
  idempotencyKey: string
  permissionKind: 'local-read' | 'workspace-write' | 'external-read' | 'external-write' | 'destructive'
  title: string
  summary: string
  details?: string
  taskId?: string
  payload: unknown
  maxAttempts?: number
}

export interface ActionExecutionContext {
  actionId: string
  idempotencyKey: string
  signal: AbortSignal
}

export interface ActionHandler {
  kind: string
  execute(action: ActionRecord, context: ActionExecutionContext): Promise<unknown>
}

export interface ActionEvent {
  id: number
  actionId: string
  type: string
  data: unknown
  createdAt: string
}
