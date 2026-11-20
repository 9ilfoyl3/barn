import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { ConnectorService } from './connector-service'

const connectorValueSchema = z.union([z.string(), z.number(), z.boolean()])
const configSchema = z.record(z.string(), connectorValueSchema)
const createSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  config: configSchema,
}).strict()
const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  config: configSchema.optional(),
  enabled: z.boolean().optional(),
}).strict()
const credentialsSchema = z.object({
  connectorId: z.string().uuid(),
  values: z.record(z.string(), z.string()),
  replace: z.boolean().optional(),
}).strict()
const callSchema = z.object({
  connectorId: z.string().uuid(),
  capability: z.string().trim().min(1).max(160),
  arguments: z.record(z.string(), z.unknown()),
}).strict()
const idSchema = z.string().uuid()

export function registerConnectorIpc(
  connectors: ConnectorService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('connectors:list-definitions', (event) => {
    requireTrusted(event, isTrustedSender)
    return connectors.listDefinitions()
  })

  ipcMain.handle('connectors:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return connectors.list()
  })

  ipcMain.handle('connectors:create', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = createSchema.parse(input)
    return connectors.create(parsed)
  })

  ipcMain.handle('connectors:update', (event, connectorId: unknown, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = updateSchema.parse(input)
    return connectors.update(idSchema.parse(connectorId), {
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.config === undefined ? {} : { config: parsed.config }),
      ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
    })
  })

  ipcMain.handle('connectors:remove', (event, connectorId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return connectors.remove(idSchema.parse(connectorId))
  })

  ipcMain.handle('connectors:save-credentials', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = credentialsSchema.parse(input)
    return connectors.saveCredentials({
      connectorId: parsed.connectorId,
      values: parsed.values,
      ...(parsed.replace === undefined ? {} : { replace: parsed.replace }),
    })
  })

  ipcMain.handle('connectors:test', (event, connectorId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return connectors.test(idSchema.parse(connectorId))
  })

  ipcMain.handle('connectors:list-actions', (event) => {
    requireTrusted(event, isTrustedSender)
    return connectors.listActions()
  })

  ipcMain.handle('connectors:retry-action', (event, actionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return connectors.retryAction(idSchema.parse(actionId))
  })

  ipcMain.handle('connectors:cancel-action', (event, actionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return connectors.cancelAction(idSchema.parse(actionId))
  })

  ipcMain.handle('connectors:call', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return connectors.call(callSchema.parse(input))
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
