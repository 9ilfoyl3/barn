import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { MemoryService } from './memory-service'

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  useMemories: z.boolean().optional(),
  generateMemories: z.boolean().optional(),
  idleMinutes: z.number().int().min(15).max(10_080).optional(),
  maxEntries: z.number().int().min(10).max(2_000).optional(),
  memoryCharLimit: z.number().int().min(200).max(20_000).optional(),
  userCharLimit: z.number().int().min(200).max(20_000).optional(),
}).strict()

const documentNameSchema = z.enum(['memory', 'user'])
const memoryUpdateSchema = z.object({
  id: z.uuid(),
  expectedVersion: z.number().int().positive(),
  title: z.string().min(1).max(120).optional(),
  content: z.string().min(1).max(2_000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  validUntil: z.string().nullable().optional(),
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
  ipcMain.handle('memory:get-document', (event, name: unknown) => {
    requireTrusted(event, isTrustedSender)
    return memory.getDocument(documentNameSchema.parse(name))
  })
  ipcMain.handle('memory:list-document-revisions', (event, name: unknown) => {
    requireTrusted(event, isTrustedSender)
    return memory.listDocumentRevisions(documentNameSchema.parse(name))
  })
  ipcMain.handle('memory:save-document', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = z.object({
      name: documentNameSchema,
      content: z.string().max(20_000),
      expectedVersion: z.number().int().nonnegative().optional(),
    }).strict().parse(value)
    return memory.saveDocument(parsed.name, parsed.content, parsed.expectedVersion)
  })
  ipcMain.handle('memory:update', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    const { id, expectedVersion, ...change } = memoryUpdateSchema.parse(value)
    return memory.update({ id, expectedVersion, ...compact(change) })
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
