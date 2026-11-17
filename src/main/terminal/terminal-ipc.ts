import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { TerminalService } from './terminal-service'

const terminalIdSchema = z.string().uuid()
const createSchema = z.object({
  terminalId: terminalIdSchema,
  workingDirectory: z.string().min(1).max(4_000).optional(),
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(5).max(100),
}).strict()
const writeSchema = z.object({
  terminalId: terminalIdSchema,
  data: z.string().max(100_000),
}).strict()
const resizeSchema = z.object({
  terminalId: terminalIdSchema,
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(5).max(100),
}).strict()

export function registerTerminalIpc(
  terminal: TerminalService,
  trustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!trustedSender(event)) throw new Error('Untrusted terminal IPC sender')
  }
  ipcMain.handle('terminal:create', (event, input: unknown) => {
    requireTrusted(event)
    return terminal.create(createSchema.parse(input))
  })
  ipcMain.handle('terminal:write', (event, input: unknown) => {
    requireTrusted(event)
    const parsed = writeSchema.parse(input)
    terminal.write(parsed.terminalId, parsed.data)
  })
  ipcMain.handle('terminal:resize', (event, input: unknown) => {
    requireTrusted(event)
    const parsed = resizeSchema.parse(input)
    terminal.resize(parsed.terminalId, parsed.cols, parsed.rows)
  })
  ipcMain.handle('terminal:dispose', (event, terminalId: unknown) => {
    requireTrusted(event)
    terminal.dispose(terminalIdSchema.parse(terminalId))
  })

  terminal.onData((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('terminal:data', event)
    }
  })
  terminal.onExit((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('terminal:exit', event)
    }
  })
}
