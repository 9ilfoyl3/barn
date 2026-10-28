import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AgentService } from '../worker/agent-service'
import { storedAttachmentFileName } from '../../shared/attachments'
import type { CommitEmployeeIntakeInput, UpdateEmployeeIntakeInput } from '../../shared/models'
import type { SessionStore } from './session-store'

export function registerSessionIpc(
  sessions: SessionStore,
  agent: AgentService,
  attachmentsRoot: string,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('sessions:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return sessions.listSessions()
  })

  ipcMain.handle('sessions:create', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    const id = z.uuid().optional().parse(sessionId)
    return sessions.createSession('New HRBP session', id)
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
      })).max(50).optional(),
    }).parse(input)
    return agent.prompt(parsed.sessionId, parsed.text, parsed.attachments ?? [])
  })

  ipcMain.handle('sessions:cancel', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return agent.cancel(z.string().min(1).parse(sessionId))
  })

  ipcMain.handle('intake:get', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return agent.getIntake(z.string().min(1).parse(sessionId))
  })

  ipcMain.handle('intake:update-employee', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({
      sessionId: z.string().min(1),
      employeeId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      fields: z.record(z.string().min(1).max(100), z.string().max(10_000)),
    }).parse(input) as UpdateEmployeeIntakeInput
    return agent.updateIntakeEmployee(parsed)
  })

  ipcMain.handle('intake:preview', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return agent.previewIntake(z.string().min(1).parse(sessionId))
  })

  ipcMain.handle('intake:list-employees', (event) => {
    requireTrusted(event, isTrustedSender)
    return agent.listEmployees()
  })

  ipcMain.handle('intake:commit', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({
      sessionId: z.string().min(1),
      previewId: z.string().min(1),
      previewHash: z.string().regex(/^[a-f0-9]{64}$/),
      employeeIds: z.array(z.string().min(1)).min(1),
    }).parse(input) as CommitEmployeeIntakeInput
    return agent.commitIntake(parsed)
  })

  ipcMain.handle('sessions:attach', async (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    const id = z.uuid().parse(sessionId)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null) throw new Error('No active window')
    const result = await dialog.showOpenDialog(window, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []

    const sessionDirectory = join(attachmentsRoot, id)
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
    return Promise.all(result.filePaths.map(async (sourcePath) => {
      const name = basename(sourcePath)
      const destination = join(sessionDirectory, storedAttachmentFileName(randomUUID(), name))
      await copyFile(sourcePath, destination)
      const info = await stat(destination)
      return { name, path: destination, size: info.size }
    }))
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
