import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { CreateConnectorSourceInput } from '../../shared/models'
import type { ConnectorSourceService } from './connector-source-service'

const sourceIdSchema = z.string().uuid()
const githubConfigSchema = z.object({
  kind: z.literal('github'),
  connectorId: z.string().trim().min(1).max(200),
  owner: z.string().trim().min(1).max(200),
  repo: z.string().trim().min(1).max(200),
  events: z.array(z.enum(['issues', 'pullRequests'])).min(1).max(2),
  pollSeconds: z.number().int().min(30).max(3_600),
}).strict()
const dingtalkConfigSchema = z.object({
  kind: z.literal('dingtalk'),
  connectorId: z.string().trim().min(1).max(200),
  conversationId: z.string().trim().min(1).max(500).optional(),
  userId: z.string().trim().min(1).max(500).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20),
  events: z.array(z.enum(['messages', 'todos'])).min(1).max(2),
  pollSeconds: z.number().int().min(30).max(3_600),
}).strict().refine((value) => (value.conversationId === undefined) !== (value.userId === undefined), {
  message: 'Choose exactly one DingTalk conversation or user',
})
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: z.union([githubConfigSchema, dingtalkConfigSchema]),
}).strict()

export function registerConnectorSourceIpc(
  sources: ConnectorSourceService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('connector-sources:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return sources.list()
  })

  ipcMain.handle('connector-sources:list-events', (event, sourceId: unknown, limit: unknown) => {
    requireTrusted(event, isTrustedSender)
    return sources.listEvents(
      sourceId === undefined ? undefined : sourceIdSchema.parse(sourceId),
      limit === undefined ? undefined : z.number().int().min(1).max(200).parse(limit),
    )
  })

  ipcMain.handle('connector-sources:create', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return sources.create(createSchema.parse(input) as CreateConnectorSourceInput)
  })

  ipcMain.handle('connector-sources:set-enabled', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({ sourceId: sourceIdSchema, enabled: z.boolean() }).strict().parse(input)
    return sources.setEnabled(parsed.sourceId, parsed.enabled)
  })

  ipcMain.handle('connector-sources:remove', (event, sourceId: unknown) => {
    requireTrusted(event, isTrustedSender)
    sources.remove(sourceIdSchema.parse(sourceId))
  })

  ipcMain.handle('connector-sources:poll-now', async (event) => {
    requireTrusted(event, isTrustedSender)
    await sources.pollNow()
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
