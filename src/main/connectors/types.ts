import type {
  ConnectorCapabilityDefinition,
  ConnectorConfig,
  ConnectorDefinition,
} from '../../shared/models'

export interface ConnectorRecord {
  id: string
  kind: string
  name: string
  enabled: boolean
  config: ConnectorConfig
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface ConnectorExecutionContext {
  connector: ConnectorRecord
  secrets: Record<string, string>
  signal?: AbortSignal
  idempotencyKey?: string
}

export interface ConnectorAdapter {
  kind: string
  test(context: ConnectorExecutionContext): Promise<{ message: string }>
  call(
    context: ConnectorExecutionContext,
    capability: ConnectorCapabilityDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown>
}

export type ConnectorDefinitionMap = ReadonlyMap<string, ConnectorDefinition>
