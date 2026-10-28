import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ShellService } from '../sandbox/shell-service'
import { getRuntimeCapabilities } from './runtime-capabilities'

export function registerRuntimeIpc(
  shell: ShellService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('runtime:capabilities', (event) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    return getRuntimeCapabilities(shell)
  })
}
