import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { TaskConversationService } from './task-conversation-service'
import type { TaskService } from './task-service'

const taskIdSchema = z.string().uuid()
const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  origin: z.enum(['user', 'automation']),
  status: z.enum(['proposed', 'queued']).optional(),
  sessionId: z.string().uuid().optional(),
  prompt: z.string().trim().min(1).max(2_000_000).optional(),
  visiblePrompt: z.string().trim().min(1).max(2_000_000).optional(),
  kind: z.enum(['work', 'reminder']).optional(),
  scheduledFor: z.string().trim().min(1).max(100).optional(),
  recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly']).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  workingDirectory: z.string().trim().min(1).max(4_000).optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(500),
    path: z.string().trim().min(1).max(4_000),
    size: z.number().int().nonnegative(),
    kind: z.enum(['file', 'directory']).optional(),
  })).max(50).optional(),
}).strict()
const updateTaskSchema = z.object({
  taskId: taskIdSchema,
  update: z.object({
    status: z.enum(['proposed', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
    waitingReason: z.enum(['input', 'approval']).optional(),
    detail: z.string().max(2_000).optional(),
  }).strict(),
}).strict()
const updatePromptSchema = z.object({
  taskId: taskIdSchema,
  prompt: z.string().trim().min(1).max(2_000_000),
}).strict()
const assignSessionSchema = z.object({
  taskId: taskIdSchema,
  sessionId: z.string().uuid().nullable(),
}).strict()
const continueTaskSchema = z.object({
  taskId: taskIdSchema,
  text: z.string().trim().min(1).max(2_000_000),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(500),
    path: z.string().trim().min(1).max(4_000),
    size: z.number().int().nonnegative(),
    kind: z.enum(['file', 'directory']).optional(),
  })).max(50).optional(),
}).strict()

export function registerTaskIpc(
  tasks: TaskService,
  conversations: TaskConversationService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('tasks:list', (event) => {
    requireTrusted(event, isTrustedSender)
    return tasks.list()
  })

  ipcMain.handle('tasks:get', (event, taskId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return tasks.get(taskIdSchema.parse(taskId))
  })

  ipcMain.handle('tasks:create', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = createTaskSchema.parse(input)
    return tasks.create({
      title: parsed.title,
      origin: parsed.origin,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
      ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
      ...(parsed.visiblePrompt === undefined ? {} : { visiblePrompt: parsed.visiblePrompt }),
      ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
      ...(parsed.scheduledFor === undefined ? {} : { scheduledFor: parsed.scheduledFor }),
      ...(parsed.recurrence === undefined ? {} : { recurrence: parsed.recurrence }),
      ...(parsed.timezone === undefined ? {} : { timezone: parsed.timezone }),
      ...(parsed.workingDirectory === undefined ? {} : { workingDirectory: parsed.workingDirectory }),
      ...(parsed.attachments === undefined ? {} : { attachments: parsed.attachments }),
    })
  })

  ipcMain.handle('tasks:update-status', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = updateTaskSchema.parse(input)
    return tasks.updateStatus(parsed.taskId, {
      status: parsed.update.status,
      ...(parsed.update.waitingReason === undefined ? {} : { waitingReason: parsed.update.waitingReason }),
      ...(parsed.update.detail === undefined ? {} : { detail: parsed.update.detail }),
    })
  })

  ipcMain.handle('tasks:update-prompt', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = updatePromptSchema.parse(input)
    return tasks.updatePrompt(parsed.taskId, parsed.prompt)
  })

  ipcMain.handle('tasks:assign-session', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = assignSessionSchema.parse(input)
    return tasks.assignSession(parsed.taskId, parsed.sessionId)
  })

  ipcMain.handle('tasks:continue', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    const parsed = continueTaskSchema.parse(input)
    return conversations.continueTask(parsed.taskId, parsed.text, parsed.attachments ?? [])
  })

  tasks.onEvent((liveEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('tasks:event', liveEvent)
    }
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
