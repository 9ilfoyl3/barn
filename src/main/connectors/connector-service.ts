import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  ConnectorCallInput,
  ConnectorCallResult,
  ConnectorConfig,
  ConnectorConfigValue,
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorTestResult,
  CreateConnectorInput,
  PermissionOutcome,
  SaveConnectorCredentialsInput,
  UpdateConnectorInput,
} from '../../shared/models'
import type { ActionRecord, ActionRequestInput } from '../actions/types'
import type { ConnectorCredentialStore } from './connector-credentials'
import type { ConnectorStore } from './connector-store'
import type { ConnectorAdapter, ConnectorDefinitionMap, ConnectorRecord } from './types'

export interface ConnectorActionService {
  list(): ActionRecord[]
  enqueue(input: ActionRequestInput): ActionRecord
  retry(actionId: string): ActionRecord
  cancel(actionId: string, reason?: string): ActionRecord
  registerHandler(handler: {
    kind: string
    execute(action: ActionRecord, context: { actionId: string; idempotencyKey: string; signal: AbortSignal }): Promise<unknown>
  }): void
}

export interface ConnectorPermissionService {
  request(input: {
    kind: 'external-read' | 'external-write'
    title: string
    summary: string
    details?: string
    taskId?: string
  }): PermissionOutcome
  resolve(approvalId: string, decision: 'approved' | 'denied'): unknown
}

export interface ConnectorCallContext {
  sessionId?: string
  taskId?: string
}

export interface ConnectorServiceOptions {
  definitions?: ConnectorDefinitionMap
  adapters?: readonly ConnectorAdapter[]
  onChanged?: () => void
}

const effectPayloadSchema = z.object({
  connectorId: z.string().trim().min(1),
  capability: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()),
}).strict()

/** Connector discovery, configuration, read execution, and approval-backed external effects. */
export class ConnectorService {
  private readonly definitions: ConnectorDefinitionMap
  private readonly adapters = new Map<string, ConnectorAdapter>()
  private readonly onChanged: (() => void) | undefined

  constructor(
    private readonly store: ConnectorStore,
    private readonly credentials: ConnectorCredentialStore,
    private readonly getActions: () => ConnectorActionService | undefined,
    private readonly getPermissions: () => ConnectorPermissionService | undefined,
    options: ConnectorServiceOptions = {},
  ) {
    this.definitions = options.definitions ?? new Map()
    this.onChanged = options.onChanged
    for (const adapter of options.adapters ?? []) this.adapters.set(adapter.kind, adapter)
  }

  listDefinitions(): ConnectorDefinition[] {
    return [...this.definitions.values()].toSorted((left, right) => left.name.localeCompare(right.name))
  }

  async list(): Promise<ConnectorInstance[]> {
    const instances: ConnectorInstance[] = []
    for (const record of this.store.list()) instances.push(await this.toInstance(record))
    return instances
  }

  async get(id: string): Promise<ConnectorInstance> {
    return this.toInstance(this.store.get(id))
  }

  async create(input: CreateConnectorInput): Promise<ConnectorInstance> {
    const definition = this.requireDefinition(input.kind)
    const config = normalizeConfig(definition, input.config)
    const name = input.name.trim() || definition.name
    const created = this.toInstance(this.store.create({ kind: definition.kind, name, config }))
    this.onChanged?.()
    return created
  }

  async update(connectorId: string, input: UpdateConnectorInput): Promise<ConnectorInstance> {
    const current = this.store.get(connectorId)
    const definition = this.requireDefinition(current.kind)
    const config = input.config === undefined ? undefined : normalizeConfig(definition, input.config)
    const updated = this.toInstance(this.store.update(connectorId, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(config === undefined ? {} : { config }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }))
    this.onChanged?.()
    return updated
  }

  async remove(connectorId: string): Promise<void> {
    this.store.get(connectorId)
    await this.credentials.delete(connectorId)
    this.store.remove(connectorId)
    this.onChanged?.()
  }

  /** Remove connectors for providers that are no longer shipped, including their encrypted credentials. */
  async removeUnsupportedKinds(kinds: readonly string[]): Promise<number> {
    const unsupported = new Set(kinds)
    let removed = 0
    for (const record of this.store.list()) {
      if (!unsupported.has(record.kind)) continue
      await this.credentials.delete(record.id)
      this.store.remove(record.id)
      removed++
    }
    return removed
  }

  async saveCredentials(input: SaveConnectorCredentialsInput): Promise<ConnectorInstance> {
    const connector = this.store.get(input.connectorId)
    const definition = this.requireDefinition(connector.kind)
    const allowed = new Set(definition.credentialFields.map((field) => field.key))
    const values = Object.fromEntries(
      Object.entries(input.values).filter(([key, value]) => allowed.has(key) && value.length > 0),
    )
    await this.credentials.save(input.connectorId, values, input.replace === true)
    const saved = this.toInstance(this.store.setError(input.connectorId, undefined))
    this.onChanged?.()
    return saved
  }

  async test(connectorId: string): Promise<ConnectorTestResult> {
    const startedAt = Date.now()
    try {
      const { record, secrets } = await this.executionContext(connectorId)
      const adapter = this.adapters.get(record.kind)
      if (adapter === undefined) throw new Error(`${record.kind} connector adapter is unavailable`)
      const result = await adapter.test({ connector: record, secrets })
      this.store.setError(connectorId, undefined)
      return { ok: true, message: result.message, latencyMs: Date.now() - startedAt }
    } catch (error) {
      const message = errorMessage(error)
      this.store.setError(connectorId, message)
      return { ok: false, message, latencyMs: Date.now() - startedAt }
    }
  }

  listActions(): import('../../shared/models').ConnectorActionSummary[] {
    const actions = this.getActions()
    if (actions === undefined) return []
    return actions.list()
      .filter((action) => action.kind === 'connector.effect')
      .slice(0, 20)
      .map((action) => this.toActionSummary(action))
  }

  private toActionSummary(action: ActionRecord): import('../../shared/models').ConnectorActionSummary {
    return {
      id: action.id,
      ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
      title: action.title,
      summary: action.summary,
      ...(action.details === undefined ? {} : { details: action.details }),
      status: action.status,
      attempts: action.attempts,
      ...(action.lastError === undefined ? {} : { lastError: action.lastError }),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.completedAt === undefined ? {} : { completedAt: action.completedAt }),
    }
  }

  /** Clear approvals queued before a capability was changed to direct execution. */
  reconcileDirectWriteApprovals(): number {
    const actions = this.getActions()
    const permissions = this.getPermissions()
    if (actions === undefined || permissions === undefined) return 0
    let reconciled = 0
    for (const action of actions.list()) {
      if (action.kind !== 'connector.effect' || action.status !== 'pending_approval') continue
      if (action.approvalId === undefined) continue
      const parsed = effectPayloadSchema.safeParse(action.payload)
      if (!parsed.success) continue
      let record: ConnectorRecord
      try {
        record = this.store.get(parsed.data.connectorId)
      } catch {
        continue
      }
      const definition = this.definitions.get(record.kind)
      const capability = definition?.capabilities.find((entry) => entry.id === parsed.data.capability)
      if (capability?.risk !== 'external-write' || capability.requiresApproval !== false) continue
      actions.cancel(action.id, 'Cancelled because this connector now executes direct sends without approval.')
      try {
        permissions.resolve(action.approvalId, 'denied')
      } catch {
        // The action is already terminal; leave any inconsistent approval untouched for manual review.
      }
      reconciled++
    }
    return reconciled
  }

  retryAction(actionId: string): Promise<import('../../shared/models').ConnectorActionSummary> {
    return this.mutateAction(actionId, (actions) => actions.retry(actionId))
  }

  cancelAction(actionId: string): Promise<import('../../shared/models').ConnectorActionSummary> {
    return this.mutateAction(actionId, (actions) => actions.cancel(actionId, 'Cancelled from the connector inbox.'))
  }

  private async mutateAction(
    actionId: string,
    mutate: (actions: ConnectorActionService) => ActionRecord,
  ): Promise<import('../../shared/models').ConnectorActionSummary> {
    const actions = this.requireActions()
    const current = actions.list().find((action) => action.id === actionId)
    if (current === undefined || current.kind !== 'connector.effect') {
      throw new Error(`Unknown connector action: ${actionId}`)
    }
    const action = mutate(actions)
    return this.toActionSummary(action)
  }

  /** Router-facing connector path: discovery plus reads only, never an approval-backed write. */
  async callRead(input: ConnectorCallInput, context: ConnectorCallContext = {}): Promise<ConnectorCallResult> {
    const { record } = await this.executionContext(input.connectorId)
    if (!record.enabled) throw new Error('This connector is disabled')
    const definition = this.requireDefinition(record.kind)
    const capability = definition.capabilities.find((entry) => entry.id === input.capability)
    if (capability === undefined) throw new Error(`Unknown connector capability: ${input.capability}`)
    if (capability.risk !== 'read') throw new Error('This connector capability is not a read capability')
    return this.call(input, context)
  }

  async call(input: ConnectorCallInput, context: ConnectorCallContext = {}): Promise<ConnectorCallResult> {
    const { record, secrets } = await this.executionContext(input.connectorId)
    if (!record.enabled) throw new Error('This connector is disabled')
    const definition = this.requireDefinition(record.kind)
    const capability = definition.capabilities.find((entry) => entry.id === input.capability)
    if (capability === undefined) throw new Error(`Unknown connector capability: ${input.capability}`)
    const adapter = this.adapters.get(record.kind)
    if (adapter === undefined) throw new Error(`${record.kind} connector adapter is unavailable`)

    if (capability.risk === 'external-write' && capability.requiresApproval === false) {
      try {
        const value = await adapter.call({ connector: record, secrets }, capability, input.arguments)
        this.store.setError(record.id, undefined)
        return { kind: 'result', value }
      } catch (error) {
        this.store.setError(record.id, errorMessage(error))
        throw error
      }
    }

    if (capability.risk === 'read') {
      const permissions = this.requirePermissions()
      const permission = permissions.request({
        kind: 'external-read',
        title: capability.name,
        summary: `${record.name}: ${capability.description}`,
        ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      })
      if (permission.decision === 'denied') throw new Error(permission.reason)
      if (permission.decision === 'approval_required') {
        throw new Error('External reads currently require the external-read policy to be set to allow')
      }
      try {
        const value = await adapter.call({ connector: record, secrets }, capability, input.arguments)
        this.store.setError(record.id, undefined)
        return { kind: 'result', value }
      } catch (error) {
        this.store.setError(record.id, errorMessage(error))
        throw error
      }
    }

    const actions = this.requireActions()
    const action = actions.enqueue({
      kind: 'connector.effect',
      idempotencyKey: effectIdempotencyKey(record.id, capability.id, input.arguments, context.sessionId),
      permissionKind: 'external-write',
      title: capability.name,
      summary: `${record.name}: ${capability.description}`,
      details: summarizeConnectorArguments(input.arguments),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      payload: {
        connectorId: record.id,
        capability: capability.id,
        arguments: input.arguments,
      },
    })
    return {
      kind: 'action',
      actionId: action.id,
      status: action.status,
      message: action.status === 'pending_approval'
        ? 'The action is waiting for user approval.'
        : 'The action was queued for execution.',
    }
  }

  /** Executes a write action after the ActionService has approved and claimed it. */
  async executeEffect(payload: unknown, context: { idempotencyKey: string; signal: AbortSignal }): Promise<unknown> {
    const parsed = effectPayloadSchema.parse(payload)
    const { record, secrets } = await this.executionContext(parsed.connectorId)
    if (!record.enabled) throw new Error('This connector is disabled')
    const definition = this.requireDefinition(record.kind)
    const capability = definition.capabilities.find((entry) => entry.id === parsed.capability)
    if (capability === undefined || capability.risk !== 'external-write') {
      throw new Error(`Not an external-write connector capability: ${parsed.capability}`)
    }
    const adapter = this.adapters.get(record.kind)
    if (adapter === undefined) throw new Error(`${record.kind} connector adapter is unavailable`)
    try {
      const result = await adapter.call({
        connector: record,
        secrets,
        idempotencyKey: context.idempotencyKey,
        signal: context.signal,
      }, capability, parsed.arguments)
      this.store.setError(record.id, undefined)
      return result
    } catch (error) {
      this.store.setError(record.id, errorMessage(error))
      throw error
    }
  }

  registerActionHandler(actions: ConnectorActionService): void {
    actions.registerHandler({
      kind: 'connector.effect',
      execute: async (action, context) => this.executeEffect(action.payload, context),
    })
  }

  private async executionContext(connectorId: string): Promise<{
    record: ConnectorRecord
    secrets: Record<string, string>
  }> {
    const record = this.store.get(connectorId)
    const secrets = await this.credentials.read(connectorId)
    return { record, secrets }
  }

  private async toInstance(record: ConnectorRecord): Promise<ConnectorInstance> {
    const definition = this.requireDefinition(record.kind)
    const credentialKeys = new Set(await this.credentials.keys(record.id))
    const configured = isConfigured(definition, record.config, credentialKeys)
    const instance: ConnectorInstance = {
      id: record.id,
      kind: record.kind,
      name: record.name,
      enabled: record.enabled,
      configured,
      status: !record.enabled
        ? 'disabled'
        : record.lastError !== undefined
          ? 'error'
          : configured
            ? 'ready'
            : 'needs_setup',
      config: record.config,
      capabilities: definition.capabilities,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
    if (record.lastError !== undefined) instance.lastError = record.lastError
    return instance
  }

  private requireDefinition(kind: string): ConnectorDefinition {
    const definition = this.definitions.get(kind)
    if (definition === undefined) throw new Error(`Unknown connector kind: ${kind}`)
    return definition
  }

  private requireActions(): ConnectorActionService {
    const actions = this.getActions()
    if (actions === undefined) throw new Error('Connector actions are unavailable')
    return actions
  }

  private requirePermissions(): ConnectorPermissionService {
    const permissions = this.getPermissions()
    if (permissions === undefined) throw new Error('Connector permissions are unavailable')
    return permissions
  }
}

function normalizeConfig(definition: ConnectorDefinition, config: ConnectorConfig): ConnectorConfig {
  const next: ConnectorConfig = {}
  for (const field of definition.configFields) {
    const raw = config[field.key] ?? field.defaultValue
    if (raw === undefined || raw === '') {
      if (field.required) throw new Error(`${field.label} is required`)
      continue
    }
    if (field.type === 'number') {
      const value = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(value) || value < 1 || value > 65_535) throw new Error(`${field.label} is invalid`)
      next[field.key] = Math.floor(value)
      continue
    }
    if (field.type === 'boolean') {
      next[field.key] = typeof raw === 'boolean' ? raw : raw === 'true'
      continue
    }
    const value = String(raw).trim()
    if (value.length === 0) {
      if (field.required) throw new Error(`${field.label} is required`)
      continue
    }
    if (value.length > 4_000) throw new Error(`${field.label} is too long`)
    next[field.key] = value
  }
  return next
}

function isConfigured(
  definition: ConnectorDefinition,
  config: ConnectorConfig,
  credentialKeys: Set<string>,
): boolean {
  return definition.configFields.every((field) => !field.required || hasConfigValue(config[field.key]))
    && definition.credentialFields.every((field) => !field.required || credentialKeys.has(field.key))
}

function hasConfigValue(value: ConnectorConfigValue | undefined): boolean {
  if (value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function effectIdempotencyKey(
  connectorId: string,
  capability: string,
  args: Record<string, unknown>,
  sessionId?: string,
): string {
  return `connector:${createHash('sha256')
    .update(JSON.stringify({ connectorId, capability, args, sessionId: sessionId ?? null }))
    .digest('hex')}`
}

function summarizeConnectorArguments(args: Record<string, unknown>): string {
  const summary = JSON.stringify(args)
  return summary.length <= 2_000 ? summary : `${summary.slice(0, 2_000)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
