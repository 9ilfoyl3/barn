import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { DiagnosticsService } from './diagnostics-service'

export function registerDiagnosticsIpc(
  diagnostics: DiagnosticsService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('diagnostics:get', (event) => {
    requireTrusted(event, isTrustedSender)
    return diagnostics.get()
  })
  ipcMain.handle('diagnostics:set-retention', (event, days: unknown) => {
    requireTrusted(event, isTrustedSender)
    return diagnostics.setRetentionDays(z.number().int().min(30).max(3_650).parse(days))
  })
  ipcMain.handle('diagnostics:run-maintenance', (event) => {
    requireTrusted(event, isTrustedSender)
    return diagnostics.runMaintenance()
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
