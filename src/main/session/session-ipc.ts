import { randomUUID } from 'node:crypto'
import { cp, copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AgentService } from '../worker/agent-service'
import { storedAttachmentFileName } from '../../shared/attachments'
import type { SessionStore } from './session-store'
import { nativeCopy, nativeLocale, type NativeLocale } from '../platform/native-locale'

export function registerSessionIpc(
  sessions: SessionStore,
  agent: AgentService,
  attachmentsRoot: string,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  getLocale: () => NativeLocale = () => nativeLocale(),
): void {
  ipcMain.handle('sessions:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return sessions.listSessions()
  })

  ipcMain.handle('sessions:create', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    const id = z.uuid().optional().parse(sessionId)
    return sessions.createSession('New session', id)
  })

  ipcMain.handle('sessions:get-events', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return agent.getEvents(z.string().min(1).parse(sessionId))
  })

  ipcMain.handle('sessions:prompt', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({
      sessionId: z.string().min(1),
      text: z.string().min(1).max(2_000_000),
      attachments: z.array(z.object({
        name: z.string().min(1).max(500),
        path: z.string().min(1).max(4_000),
        size: z.number().int().nonnegative(),
        kind: z.enum(['file', 'directory']).optional(),
      })).max(50).optional(),
      workingDirectory: z.string().min(1).max(4_000).optional(),
    }).parse(input)
    return agent.prompt(
      parsed.sessionId,
      parsed.text,
      parsed.attachments ?? [],
      parsed.workingDirectory,
    )
  })

  ipcMain.handle('sessions:cancel', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return agent.cancel(z.string().min(1).parse(sessionId))
  })

  ipcMain.handle('sessions:attach', async (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    const id = z.uuid().parse(sessionId)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null) throw new Error(nativeCopy(getLocale()).noActiveWindow)
    const result = await dialog.showOpenDialog(window, {
      title: nativeCopy(getLocale()).attachFilesAndFolders,
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    })
    if (result.canceled) return []

    const sessionDirectory = join(attachmentsRoot, id)
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
    return Promise.all(result.filePaths.map(async (sourcePath) => {
      const name = basename(sourcePath)
      const destination = join(sessionDirectory, storedAttachmentFileName(randomUUID(), name))
      const sourceInfo = await stat(sourcePath)
      if (sourceInfo.isDirectory()) {
        await cp(sourcePath, destination, { recursive: true, force: true, errorOnExist: false })
        return { name, path: destination, size: 0, kind: 'directory' as const }
      }
      await copyFile(sourcePath, destination)
      const info = await stat(destination)
      return { name, path: destination, size: info.size, kind: 'file' as const }
    }))
  })

  ipcMain.handle('sessions:choose-directory', async (event) => {
    requireTrusted(event, isTrustedSender)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null) throw new Error(nativeCopy(getLocale()).noActiveWindow)
    const result = await dialog.showOpenDialog(window, {
      title: nativeCopy(getLocale()).chooseWorkingDirectory,
      properties: ['openDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })

  ipcMain.handle('sessions:set-working-directory', async (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({
      sessionId: z.string().min(1),
      workingDirectory: z.string().min(1).max(4_000),
    }).parse(input)
    const info = await stat(parsed.workingDirectory)
    if (!info.isDirectory()) throw new Error('Working directory must be a directory')
    return agent.setWorkingDirectory(parsed.sessionId, parsed.workingDirectory)
  })

  ipcMain.handle('sessions:clear-working-directory', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return agent.clearWorkingDirectory(z.string().min(1).parse(sessionId))
  })

  agent.onLiveEvent((liveEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('sessions:event', liveEvent)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
