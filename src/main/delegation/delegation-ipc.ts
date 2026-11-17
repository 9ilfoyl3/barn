import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { classifyDelegation } from './delegation-policy'

const inputSchema = z.object({
  text: z.string().max(2_000_000),
  attachmentNames: z.array(z.string().min(1).max(500)).max(50).optional(),
  hasWorkingDirectory: z.boolean().optional(),
}).strict()

export function registerDelegationIpc(
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('delegation:classify', (event, input: unknown) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    const parsed = inputSchema.parse(input)
    return classifyDelegation({
      text: parsed.text,
      ...(parsed.attachmentNames === undefined ? {} : { attachmentNames: parsed.attachmentNames }),
      ...(parsed.hasWorkingDirectory === undefined ? {} : { hasWorkingDirectory: parsed.hasWorkingDirectory }),
    })
  })
}
