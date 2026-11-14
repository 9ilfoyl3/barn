import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { PermissionService } from '../../src/main/permissions/permission-service'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-permission-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const permissions = new PermissionService(sessions.permissions, tasks)
  return { sessions, tasks, permissions }
}

describe('PermissionService', () => {
  it('allows, blocks, or requests approval from policy', async () => {
    const h = await harness()
    const task = h.tasks.create({ title: 'Send an update', origin: 'user', prompt: 'Send the update.' })

    const requested = h.permissions.request({
      kind: 'external-write',
      title: 'Send the update',
      summary: 'Send the prepared update externally.',
      taskId: task.id,
    })
    expect(requested.decision).toBe('approval_required')
    if (requested.decision !== 'approval_required') throw new Error('approval expected')
    expect(h.tasks.get(task.id)).toMatchObject({
      status: 'waiting',
      waitingReason: 'approval',
      approvalId: requested.approval.id,
    })

    h.permissions.setPolicy({
      localRead: 'allow',
      workspaceWrite: 'allow',
      externalWrite: 'allow',
      destructive: 'deny',
    })
    expect(h.permissions.request({
      kind: 'external-write',
      title: 'Send the update',
      summary: 'Send the prepared update externally.',
    })).toEqual({ decision: 'allowed' })
    expect(h.permissions.request({
      kind: 'destructive',
      title: 'Delete files',
      summary: 'Delete the source files.',
    })).toEqual({
      decision: 'denied',
      reason: 'destructive is blocked by your safety settings.',
    })
    h.sessions.close()
  })

  it('queues an approved task and cancels a denied task', async () => {
    const h = await harness()
    const approvedTask = h.tasks.create({ title: 'Approved task', origin: 'user', prompt: 'Continue.' })
    const approved = h.permissions.request({
      kind: 'external-write',
      title: 'Approve sending',
      summary: 'Send the approved content.',
      taskId: approvedTask.id,
    })
    if (approved.decision !== 'approval_required') throw new Error('approval expected')
    h.permissions.resolve(approved.approval.id, 'approved')
    expect(h.tasks.get(approvedTask.id)).toMatchObject({
      status: 'queued',
      detail: 'Approved by a person.',
    })
    expect(h.tasks.get(approvedTask.id).approvalId).toBeUndefined()

    const deniedTask = h.tasks.create({ title: 'Denied task', origin: 'user', prompt: 'Continue.' })
    const denied = h.permissions.request({
      kind: 'destructive',
      title: 'Approve deletion',
      summary: 'Delete the source files.',
      taskId: deniedTask.id,
    })
    if (denied.decision !== 'approval_required') throw new Error('approval expected')
    h.permissions.resolve(denied.approval.id, 'denied')
    expect(h.tasks.get(deniedTask.id)).toMatchObject({
      status: 'cancelled',
      detail: 'Denied by a person.',
    })
    h.sessions.close()
  })
})
