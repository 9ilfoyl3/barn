import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { HrClient } from './hr-client'

const lifecycleStatusSchema = z.enum([
  'preboarding',
  'onboarding',
  'probation',
  'active',
  'offboarding',
  'terminated',
])

const lifecycleStatusSchemaForTemplate = z.enum([
  'preboarding',
  'onboarding',
  'probation',
  'active',
  'offboarding',
  'terminated',
])

const lifecycleTaskTemplateSchema = z.object({
  fromStatus: lifecycleStatusSchemaForTemplate,
  toStatus: lifecycleStatusSchemaForTemplate,
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(1_000).optional(),
  assigneeRole: z.string().trim().min(1).max(100).optional(),
  dueOffsetDays: z.number().int().min(-365).max(365).optional(),
  required: z.boolean().optional(),
})

const lifecycleTaskTemplateUpdateSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.union([z.string().trim().max(1_000), z.null()]).optional(),
  assigneeRole: z.string().trim().min(1).max(100).optional(),
  dueOffsetDays: z.number().int().min(-365).max(365).optional(),
  required: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

const lifecycleTaskUpdateSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  status: z.enum(['pending', 'completed', 'blocked']).optional(),
  assigneeUserId: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
  dueAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
})

const lifecycleCaseSearchSchema = z.object({
  status: z.enum(['pending_approval', 'scheduled', 'completed', 'rejected', 'blocked']).optional(),
  employeeId: z.string().uuid().optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
}).optional()

const lifecycleProposalSchema = z.object({
  toStatus: lifecycleStatusSchema,
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(3).max(1_000),
})

const lifecycleDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  idempotencyKey: z.string().trim().min(8).max(200),
})

const employeeSearchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: lifecycleStatusSchema.optional(),
  orgUnitId: z.string().uuid().optional(),
  orgUnitCode: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  fields: z.string().trim().max(1_000).optional(),
}).optional()

export function registerHrIpc(
  client: HrClient,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('hr:search-employees', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.searchEmployees(employeeSearchSchema.parse(input))
  })
  ipcMain.handle('hr:get-employee', (event, employeeId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.getEmployee(z.string().min(1).max(200).parse(employeeId))
  })
  ipcMain.handle('hr:get-org-unit', (event, idOrCode: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.getOrgUnit(z.string().min(1).max(200).parse(idOrCode))
  })
  ipcMain.handle('hr:list-lifecycle-task-templates', (event) => {
    requireTrusted(event, isTrustedSender)
    return client.listLifecycleTaskTemplates()
  })
  ipcMain.handle('hr:create-lifecycle-task-template', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.createLifecycleTaskTemplate(lifecycleTaskTemplateSchema.parse(input))
  })
  ipcMain.handle('hr:update-lifecycle-task-template', (event, templateId: unknown, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.updateLifecycleTaskTemplate(
      z.string().min(1).max(200).parse(templateId),
      lifecycleTaskTemplateUpdateSchema.parse(input),
    )
  })
  ipcMain.handle('hr:update-lifecycle-task', (event, caseId: unknown, taskId: unknown, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.updateLifecycleTask(
      z.string().min(1).max(200).parse(caseId),
      z.string().min(1).max(200).parse(taskId),
      lifecycleTaskUpdateSchema.parse(input),
    )
  })
  ipcMain.handle('hr:list-notifications', (event, unreadOnly: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.listNotifications(z.boolean().parse(unreadOnly ?? false))
  })
  ipcMain.handle('hr:mark-notification-read', (event, notificationId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.markNotificationRead(z.string().min(1).max(200).parse(notificationId))
  })
  ipcMain.handle('hr:list-lifecycle-cases', (event, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.listLifecycleCases(lifecycleCaseSearchSchema.parse(input))
  })
  ipcMain.handle('hr:get-lifecycle-case', (event, caseId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.getLifecycleCase(z.string().min(1).max(200).parse(caseId))
  })
  ipcMain.handle('hr:get-lifecycle', (event, employeeId: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.getLifecycle(z.string().min(1).max(200).parse(employeeId))
  })
  ipcMain.handle('hr:propose-lifecycle-transition', (event, employeeId: unknown, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.proposeLifecycleTransition(
      z.string().min(1).max(200).parse(employeeId),
      lifecycleProposalSchema.parse(input),
    )
  })
  ipcMain.handle('hr:decide-lifecycle-proposal', (event, proposalId: unknown, input: unknown) => {
    requireTrusted(event, isTrustedSender)
    return client.decideLifecycleProposal(
      z.string().min(1).max(200).parse(proposalId),
      lifecycleDecisionSchema.parse(input),
    )
  })
  ipcMain.handle('hr:list-employees', (event) => {
    requireTrusted(event, isTrustedSender)
    return client.listEmployees()
  })
}

function requireTrusted(
  event: IpcMainInvokeEvent,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
}
