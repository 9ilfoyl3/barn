import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { cp, copyFile, mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
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

  ipcMain.handle('sessions:attachment-preview', async (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const path = await realpath(z.string().min(1).max(4_000).parse(input))
    const root = await realpath(attachmentsRoot)
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
      throw new Error('Attachment preview is outside the managed attachment store')
    }
    const info = await stat(path)
    if (!info.isFile()) return undefined
    const extension = extname(path).toLowerCase()
    const mime = imageMimeType(path)
    if (mime !== undefined) {
      if (info.size > 10 * 1024 * 1024) return undefined
      return { kind: 'image', dataUrl: `data:${mime};base64,${(await readFile(path)).toString('base64')}` }
    }
    if (!TEXT_PREVIEW_EXTENSIONS.has(extension)) return undefined
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, 8 * 1024))
      await file.read(buffer, 0, buffer.length, 0)
      if (!isUtf8(buffer)) return undefined
      const text = buffer.toString('utf8').replace(/\r\n?/g, '\n').slice(0, 1_200)
      return { kind: 'text', text }
    } finally {
      await file.close()
    }
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

function imageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    default: return undefined
  }
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.sql', '.log', '.toml',
  '.ini', '.sh', '.bat', '.ps1', '.rst',
])
