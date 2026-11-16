import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { PermissionService } from './permission-service'

const modeSchema = z.enum(['allow', 'ask', 'deny'])
const policySchema = z.object({
  localRead: modeSchema,
  workspaceWrite: modeSchema,
  externalWrite: modeSchema,
  destructive: modeSchema,
}).strict()
const requestSchema = z.object({
  kind: z.enum(['local-read', 'workspace-write', 'external-write', 'destructive']),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  details: z.string().trim().min(1).max(20_000).optional(),
  taskId: z.string().uuid().optional(),
}).strict()
const approvalIdSchema = z.string().uuid()
const resolveSchema = z.object({
  approvalId: approvalIdSchema,
  decision: z.enum(['approved', 'denied']),
}).strict()

export function registerPermissionIpc(
  permissions: PermissionService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  permissions.onChange((approval) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('approvals:event', approval)
    }
  })

  ipcMain.handle('permissions:get-policy', (event) => {
    requireTrusted(event, isTrustedSender)
    return permissions.getPolicy()
  })

  ipcMain.handle('permissions:set-policy', (event, policy: unknown) => {
    requireTrusted(event, isTrustedSender)
    return permissions.setPolicy(policySchema.parse(policy))
  })

  ipcMain.handle('permissions:request', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = requestSchema.parse(input)
    return permissions.request({
      kind: parsed.kind,
      title: parsed.title,
      summary: parsed.summary,
      ...(parsed.details === undefined ? {} : { details: parsed.details }),
      ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }),
    })
  })

  ipcMain.handle('approvals:list-pending', (event) => {
    requireTrusted(event, isTrustedSender)
    return permissions.listPending()
  })

  ipcMain.handle('approvals:get', (event, approvalId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return permissions.get(approvalIdSchema.parse(approvalId))
  })

  ipcMain.handle('approvals:resolve', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = resolveSchema.parse(input)
    return permissions.resolve(parsed.approvalId, parsed.decision)
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
