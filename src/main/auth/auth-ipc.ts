import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuthService } from './auth-service.js'

export function registerAuthIpc(
  auth: AuthService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('auth:get-state', (event) => {
    requireTrusted(event, isTrustedSender)
    return auth.getState()
  })
  ipcMain.handle('auth:login', (event) => {
    requireTrusted(event, isTrustedSender)
    return auth.login()
  })
  ipcMain.handle('auth:logout', (event) => {
    requireTrusted(event, isTrustedSender)
    return auth.logout()
  })

  auth.onStateChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('auth:state-changed', state)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
