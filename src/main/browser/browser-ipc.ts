import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { BrowserService } from './browser-service'

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
})

const urlSchema = z.string().min(1).max(20_000)
const tabIdSchema = z.string().uuid()

export function registerBrowserIpc(
  getBrowser: () => BrowserService | undefined,
  trustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  const requireTrusted = (event: IpcMainInvokeEvent): BrowserService => {
    if (!trustedSender(event)) throw new Error('Untrusted browser IPC sender')
    const browser = getBrowser()
    if (browser === undefined) throw new Error('Browser is unavailable')
    return browser
  }

  ipcMain.handle('browser:get-state', (event) => requireTrusted(event).getState())
  ipcMain.handle('browser:open', (event, rawUrl?: unknown) => {
    const browser = requireTrusted(event)
    return browser.open(rawUrl === undefined ? undefined : urlSchema.parse(rawUrl))
  })
  ipcMain.handle('browser:close', (event) => requireTrusted(event).close())
  ipcMain.handle('browser:navigate', (event, rawUrl: unknown) => {
    const browser = requireTrusted(event)
    return browser.navigate(urlSchema.parse(rawUrl))
  })
  ipcMain.handle('browser:new-tab', (event, rawUrl?: unknown) => {
    const browser = requireTrusted(event)
    return browser.newTab(rawUrl === undefined ? undefined : urlSchema.parse(rawUrl))
  })
  ipcMain.handle('browser:activate-tab', (event, rawTabId: unknown) => {
    const browser = requireTrusted(event)
    return browser.activateTab(tabIdSchema.parse(rawTabId))
  })
  ipcMain.handle('browser:close-tab', (event, rawTabId: unknown) => {
    const browser = requireTrusted(event)
    return browser.closeTab(tabIdSchema.parse(rawTabId))
  })
  ipcMain.handle('browser:reveal-download', (event, rawDownloadId: unknown) => {
    const browser = requireTrusted(event)
    return browser.revealDownload(tabIdSchema.parse(rawDownloadId))
  })
  ipcMain.handle('browser:back', (event) => requireTrusted(event).back())
  ipcMain.handle('browser:forward', (event) => requireTrusted(event).forward())
  ipcMain.handle('browser:reload', (event) => requireTrusted(event).reload())
  ipcMain.handle('browser:set-bounds', (event, rawBounds: unknown) => {
    const browser = requireTrusted(event)
    browser.setBounds(boundsSchema.parse(rawBounds))
  })
  ipcMain.handle('browser:capture', (event) => requireTrusted(event).capture())
}
