import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { DingTalkRuntime } from './dingtalk-runtime'

export function registerDingTalkIpc(
  runtime: DingTalkRuntime,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('dingtalk:status', (event) => {
    requireTrusted(event, isTrustedSender)
    return runtime.status()
  })
  ipcMain.handle('dingtalk:install', (event) => {
    requireTrusted(event, isTrustedSender)
    return runtime.install()
  })
  ipcMain.handle('dingtalk:login', (event) => {
    requireTrusted(event, isTrustedSender)
    return runtime.login()
  })
  ipcMain.handle('dingtalk:logout', async (event) => {
    requireTrusted(event, isTrustedSender)
    await runtime.logout()
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
