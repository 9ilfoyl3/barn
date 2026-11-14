import { BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import type { ShellService } from '../sandbox/shell-service'
import { getRuntimeCapabilities } from './runtime-capabilities'
import { nativeLocale, type NativeLocale } from './native-locale'

export function registerRuntimeIpc(
  shell: ShellService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  getLocale: () => NativeLocale = () => nativeLocale(),
): void {
  ipcMain.handle('runtime:capabilities', (event) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    return getRuntimeCapabilities(shell)
  })
  ipcMain.handle('runtime:native-locale', (event) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    return getLocale()
  })
  ipcMain.handle('runtime:theme-state', (event) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    return { shouldUseDarkColors: nativeTheme.shouldUseDarkColors }
  })
  nativeTheme.on('updated', () => {
    const state = { shouldUseDarkColors: nativeTheme.shouldUseDarkColors }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('runtime:theme-changed', state)
    }
  })
}
