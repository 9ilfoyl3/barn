import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { RoutineStore } from './routine-store'

const idSchema = z.string().uuid()

export function registerRoutineIpc(
  routines: RoutineStore,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('routines:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return routines.list()
  })

  ipcMain.handle('routines:acknowledge', (event, id: unknown) => {
    requireTrusted(event, isTrustedSender)
    return routines.acknowledge(idSchema.parse(id))
  })

  routines.onEvent((routineEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('routines:event', routineEvent)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
