import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { CreateConnectorSourceInput } from '../../shared/models'
import type { ConnectorSourceService } from './connector-source-service'

const sourceIdSchema = z.string().uuid()
const sharedConfigFields = {
  connectorId: z.string().trim().min(1).max(200),
  events: z.array(z.enum(['issues', 'pullRequests', 'messages', 'todos'])).min(1).max(2),
  pollSeconds: z.number().int().min(30).max(3_600),
  origin: z.enum(['github-default', 'router']).optional(),
  purpose: z.enum(['analysis', 'reply']).optional(),
  instruction: z.string().trim().min(1).max(20_000).optional(),
  mode: z.enum(['observe', 'active']).optional(),
} as const
const githubConfigSchema = z.object({
  kind: z.literal('github'),
  ...sharedConfigFields,
  events: z.array(z.enum(['issues', 'pullRequests'])).min(1).max(2),
  scope: z.enum(['repository', 'bound-user']).optional(),
  owner: z.string().trim().min(1).max(200).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  actors: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict().refine((value) => value.scope !== 'repository' || value.owner !== undefined && value.repo !== undefined, {
  message: 'A repository GitHub watch requires owner and repository',
})
const dingtalkConfigSchema = z.object({
  kind: z.literal('dingtalk'),
  ...sharedConfigFields,
  events: z.array(z.enum(['messages', 'todos'])).min(1).max(2),
  conversationId: z.string().trim().min(1).max(500).optional(),
  userId: z.string().trim().min(1).max(500).optional(),
  targetLabel: z.string().trim().min(1).max(500).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20),
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
