import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { TerminalService } from './terminal-service'

const runSchema = z.object({
  terminalId: z.string().uuid(),
  command: z.string().min(1).max(20_000),
  workingDirectory: z.string().min(1).max(4_000).optional(),
}).strict()

export function registerTerminalIpc(
  terminal: TerminalService,
  trustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!trustedSender(event)) throw new Error('Untrusted terminal IPC sender')
  }
  ipcMain.handle('terminal:run', (event, input: unknown) => {
    requireTrusted(event)
    return terminal.run(runSchema.parse(input))
  })
}
