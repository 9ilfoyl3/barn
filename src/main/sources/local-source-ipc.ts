import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { nativeCopy, nativeLocale } from '../platform/native-locale'
import type { LocalSourceService } from './local-source-service'

const sourceIdSchema = z.string().uuid()
const fileWatchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: z.object({
    kind: z.literal('file-watch'),
    path: z.string().trim().min(1).max(4_000),
    recursive: z.boolean(),
    maxDepth: z.number().int().min(0).max(8),
  }).strict(),
}).strict()
const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: z.object({
    kind: z.literal('schedule'),
    intervalMinutes: z.number().int().min(1).max(10_080),
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(20_000),
  }).strict(),
}).strict()

export function registerLocalSourceIpc(
  sources: LocalSourceService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('local-sources:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return sources.list()
  })

  ipcMain.handle('local-sources:create', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.union([fileWatchSchema, scheduleSchema]).parse(input)
    return sources.create(parsed)
  })

  ipcMain.handle('local-sources:set-enabled', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({ sourceId: sourceIdSchema, enabled: z.boolean() }).strict().parse(input)
    return sources.setEnabled(parsed.sourceId, parsed.enabled)
  })

  ipcMain.handle('local-sources:remove', (event, sourceId: unknown) => {
    requireTrusted(event, isTrustedSender)
    sources.remove(sourceIdSchema.parse(sourceId))
  })

  ipcMain.handle('local-sources:poll-now', async (event) => {
    requireTrusted(event, isTrustedSender)
    await sources.pollNow()
  })

  ipcMain.handle('local-sources:choose-directory', async (event) => {
    requireTrusted(event, isTrustedSender)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null) throw new Error(nativeCopy(nativeLocale()).noActiveWindow)
    const result = await dialog.showOpenDialog(window, {
      title: nativeCopy(nativeLocale()).chooseFolder,
      properties: ['openDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
