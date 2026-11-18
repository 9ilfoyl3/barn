import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { RouterService } from './router-service'

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(500),
  path: z.string().trim().min(1).max(4_000),
  size: z.number().int().nonnegative(),
  kind: z.enum(['file', 'directory']).optional(),
}).strict()

const submitSchema = z.object({
  text: z.string().trim().min(1).max(2_000_000),
  clientMessageId: z.string().trim().min(1).max(500).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  attachments: z.array(attachmentSchema).max(50).optional(),
  workingDirectory: z.string().trim().min(1).max(4_000).optional(),
  locale: z.enum(['en', 'zh-CN']).optional(),
}).strict()

const requestIdSchema = z.uuid()

export function registerRouterIpc(
  router: RouterService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('router:submit', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = submitSchema.parse(input)
    return router.submit({
      text: parsed.text,
      ...(parsed.clientMessageId === undefined ? {} : { clientMessageId: parsed.clientMessageId }),
      ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
      ...(parsed.attachments === undefined ? {} : { attachments: parsed.attachments }),
      ...(parsed.workingDirectory === undefined ? {} : { workingDirectory: parsed.workingDirectory }),
      ...(parsed.locale === undefined ? {} : { locale: parsed.locale }),
    })
  })

  ipcMain.handle('router:get-snapshot', (event) => {
    requireTrusted(event, isTrustedSender)
    return router.getSnapshot()
  })

  ipcMain.handle('router:cancel', (event, requestId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return router.cancel(requestIdSchema.parse(requestId))
  })

  router.onEvent((liveEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('router:event', liveEvent)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
