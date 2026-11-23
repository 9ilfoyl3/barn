import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { SkillService } from './skill-service'

const skillIdSchema = z.string().trim().min(1).max(160)
const createSkillSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  instructions: z.string().trim().min(1).max(100_000),
}).strict()
const updateSkillSchema = z.object({
  skillId: skillIdSchema,
  input: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    instructions: z.string().trim().min(1).max(100_000).optional(),
  }).strict(),
}).strict()
const setEnabledSchema = z.object({
  skillId: skillIdSchema,
  enabled: z.boolean(),
}).strict()

export function registerSkillIpc(skills: SkillService, isTrustedSender: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('skills:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return skills.list()
  })

  ipcMain.handle('skills:get', (event, skillId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return skills.get(skillIdSchema.parse(skillId))
  })

  ipcMain.handle('skills:create', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return skills.create(createSkillSchema.parse(input))
  })

  ipcMain.handle('skills:update', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = updateSkillSchema.parse(value)
    return skills.update(parsed.skillId, {
      ...(parsed.input.name === undefined ? {} : { name: parsed.input.name }),
      ...(parsed.input.description === undefined ? {} : { description: parsed.input.description }),
      ...(parsed.input.instructions === undefined ? {} : { instructions: parsed.input.instructions }),
    })
  })

  ipcMain.handle('skills:set-enabled', (event, value: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = setEnabledSchema.parse(value)
    return skills.setEnabled(parsed.skillId, parsed.enabled)
  })

  ipcMain.handle('skills:remove', (event, skillId: unknown) => {
    requireTrusted(event, isTrustedSender)
    skills.remove(skillIdSchema.parse(skillId))
  })

  skills.onEvent((liveEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('skills:event', liveEvent)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
