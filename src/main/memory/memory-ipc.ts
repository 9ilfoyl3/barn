import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { MemoryService } from './memory-service'

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  useMemories: z.boolean().optional(),
  generateMemories: z.boolean().optional(),
  idleMinutes: z.number().int().min(15).max(10_080).optional(),
  maxEntries: z.number().int().min(10).max(2_000).optional(),
}).strict()

const sessionControlsSchema = z.object({
  useMemories: z.boolean().optional(),
  generateMemories: z.boolean().optional(),
}).strict()

export function registerMemoryIpc(
  memory: MemoryService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('memory:get-settings', (event) => {
    requireTrusted(event, isTrustedSender)
    return memory.getSettings()
  })
  ipcMain.handle('memory:set-settings', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    return memory.setSettings(compact(settingsSchema.parse(value)))
  })
  ipcMain.handle('memory:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return memory.list()
  })
  ipcMain.handle('memory:list-candidates', (event) => {
    requireTrusted(event, isTrustedSender)
    return memory.listCandidates()
  })
  ipcMain.handle('memory:confirm', (event, id: unknown) => {
    requireTrusted(event, isTrustedSender)
    return memory.confirm(z.uuid().parse(id))
  })
  ipcMain.handle('memory:reject', (event, id: unknown) => {
    requireTrusted(event, isTrustedSender)
    return memory.reject(z.uuid().parse(id))
  })
  ipcMain.handle('memory:delete', (event, id: unknown) => {
    requireTrusted(event, isTrustedSender)
    memory.forget(z.uuid().parse(id))
  })
  ipcMain.handle('memory:set-pinned', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({ id: z.uuid(), pinned: z.boolean() }).strict().parse(value)
    return memory.setPinned(parsed.id, parsed.pinned)
  })
  ipcMain.handle('memory:get-session-controls', (event, sessionId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return memory.getSessionControls(z.string().min(1).parse(sessionId))
  })
  ipcMain.handle('memory:set-session-controls', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({
      sessionId: z.string().min(1),
      controls: sessionControlsSchema,
    }).strict().parse(value)
    return memory.setSessionControls(parsed.sessionId, compact(parsed.controls))
  })
}

function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
