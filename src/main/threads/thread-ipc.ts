import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AppendVisibleMessageInput } from '../../shared/models'
import type { ThreadService } from './thread-service'

const appendMessageSchema = z.object({
  clientMessageId: z.string().trim().min(1).max(500).optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceRefs: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
}).strict()

const listMessagesSchema = z.object({
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
}).strict()

export function registerThreadIpc(
  threads: ThreadService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('threads:get-snapshot', (event) => {
    requireTrusted(event, isTrustedSender)
    return threads.getSnapshot()
  })

  ipcMain.handle('threads:list-messages', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = listMessagesSchema.parse(input ?? {})
    return threads.listMessages({
      ...(parsed.afterSeq === undefined ? {} : { afterSeq: parsed.afterSeq }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    })
  })

  ipcMain.handle('threads:append-message', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = appendMessageSchema.parse(input)
    const appendInput: AppendVisibleMessageInput = {
      role: parsed.role,
      content: parsed.content,
      ...(parsed.clientMessageId === undefined ? {} : { clientMessageId: parsed.clientMessageId }),
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      ...(parsed.sourceRefs === undefined ? {} : { sourceRefs: parsed.sourceRefs }),
    }
    return threads.appendMessage(appendInput)
  })

  threads.onEvent((liveEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('threads:event', liveEvent)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
