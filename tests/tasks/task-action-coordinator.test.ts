import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ActionService } from '../../src/main/actions/action-service'
import { PermissionService } from '../../src/main/permissions/permission-service'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { TaskActionCoordinator } from '../../src/main/tasks/task-action-coordinator'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-task-action-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const permissions = new PermissionService(sessions.permissions, tasks)
  const actions = new ActionService(sessions.actions, permissions, { pollIntervalMs: 0, autoRun: false })
  const coordinator = new TaskActionCoordinator(tasks, actions)
  actions.start()
  coordinator.start()
  return { sessions, tasks, permissions, actions, coordinator }
}

describe('TaskActionCoordinator', () => {
  it('completes a waiting Task only after its approval-backed action succeeds', async () => {
    const h = await harness()
    h.actions.registerHandler({ kind: 'test.send', execute: vi.fn(async () => ({ messageId: 'm1' })) })
    const task = h.tasks.create({ title: 'Send the update', origin: 'user', prompt: 'Send it.' })
    h.tasks.updateStatus(task.id, { status: 'running' })
    h.tasks.recordPendingResult(task.id, {
      outcome: 'needs_review',
      summary: 'The message is ready to send.',
      artifacts: [],
      evidenceRefs: ['session:worker:event:1'],
      limitations: [],
      externalEffectReceipts: [],
    })

    const action = h.actions.enqueue({
      kind: 'test.send',
      idempotencyKey: 'task-send',
      permissionKind: 'external-write',
      title: 'Send update',
      summary: 'Send the update to the team.',
      taskId: task.id,
      payload: { text: 'Update' },
    })
    expect(h.tasks.get(task.id)).toMatchObject({ status: 'waiting', waitingReason: 'approval' })

    h.permissions.resolve(action.approvalId!, 'approved')
    await h.actions.runDue()

    expect(h.tasks.get(task.id)).toMatchObject({
      status: 'completed',
      result: {
        outcome: 'completed',
        summary: 'The message is ready to send.',
        externalEffectReceipts: [`action:${action.id}:succeeded`],
      },
    })
    expect(h.tasks.get(task.id).approvalId).toBeUndefined()
    h.coordinator.stop()
    h.actions.stop()
    h.sessions.close()
  })

  it('cancels the waiting Task when its approval is denied', async () => {
    const h = await harness()
    const task = h.tasks.create({ title: 'Send the update', origin: 'user', prompt: 'Send it.' })
    const action = h.actions.enqueue({
      kind: 'test.send',
      idempotencyKey: 'task-send-denied',
      permissionKind: 'external-write',
      title: 'Send update',
      summary: 'Send the update to the team.',
      taskId: task.id,
      payload: { text: 'Update' },
    })

    h.permissions.resolve(action.approvalId!, 'denied')

    expect(h.tasks.get(task.id)).toMatchObject({
      status: 'cancelled',
      detail: 'Denied by a person.',
    })
    h.coordinator.stop()
    h.actions.stop()
    h.sessions.close()
  })
})
