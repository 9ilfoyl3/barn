import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ActionService } from '../../src/main/actions/action-service'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { PermissionService } from '../../src/main/permissions/permission-service'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness(options: { now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'barn-action-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const permissions = new PermissionService(sessions.permissions, tasks)
  const actions = new ActionService(sessions.actions, permissions, {
    pollIntervalMs: 0,
    autoRun: false,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  actions.start()
  return { sessions, tasks, permissions, actions }
}

const request = {
  kind: 'test.send',
  idempotencyKey: 'send-1',
  permissionKind: 'external-write' as const,
  title: 'Send report',
  summary: 'Send the report externally.',
  payload: { reportId: 'r1' },
}

describe('ActionService', () => {
  it('executes allowed actions once and deduplicates enqueue', async () => {
    const h = await harness()
    const execute = vi.fn(async () => ({ messageId: 'm1' }))
    h.actions.registerHandler({ kind: 'test.send', execute })
    h.permissions.setPolicy({
      localRead: 'allow',
      workspaceWrite: 'allow',
      externalWrite: 'allow',
      destructive: 'ask',
    })

    const first = h.actions.enqueue(request)
    const second = h.actions.enqueue(request)
    expect(second.id).toBe(first.id)
    expect(first.status).toBe('queued')
    await h.actions.runDue()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(h.actions.get(first.id)).toMatchObject({
      status: 'succeeded',
      result: { messageId: 'm1' },
    })
    h.actions.stop()
    h.sessions.close()
  })

  it('waits for approval and executes only after approval', async () => {
    const h = await harness()
    const execute = vi.fn(async () => ({ sent: true }))
    h.actions.registerHandler({ kind: 'test.send', execute })

    const action = h.actions.enqueue(request)
    expect(action.status).toBe('pending_approval')
    expect(action.approvalId).toBeDefined()
    await h.actions.runDue()
    expect(execute).not.toHaveBeenCalled()

    h.permissions.resolve(action.approvalId!, 'approved')
    await h.actions.runDue()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(h.actions.get(action.id).status).toBe('succeeded')
    h.actions.stop()
    h.sessions.close()
  })

  it('cancels an action when its approval is denied', async () => {
    const h = await harness()
    const execute = vi.fn(async () => ({ sent: true }))
    h.actions.registerHandler({ kind: 'test.send', execute })
    const action = h.actions.enqueue(request)

    h.permissions.resolve(action.approvalId!, 'denied')
    expect(h.actions.get(action.id)).toMatchObject({
      status: 'cancelled',
      lastError: 'Denied by a person.',
    })
    await h.actions.runDue()
    expect(execute).not.toHaveBeenCalled()
    h.actions.stop()
    h.sessions.close()
  })

  it('retries a transient handler failure with a stable idempotency key', async () => {
    let nowMs = Date.parse('2026-11-14T00:00:00.000Z')
    const h = await harness({ now: () => new Date(nowMs) })
    const keys: string[] = []
    let attempts = 0
    h.actions.registerHandler({
      kind: 'test.send',
      execute: async (_action, context) => {
        keys.push(context.idempotencyKey)
        attempts++
        if (attempts === 1) throw new Error('temporary failure')
        return { sent: true }
      },
    })
    h.permissions.setPolicy({
      localRead: 'allow',
      workspaceWrite: 'allow',
      externalWrite: 'allow',
      destructive: 'ask',
    })
    const action = h.actions.enqueue(request)
    await h.actions.runDue()
    expect(h.actions.get(action.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'temporary failure',
    })

    nowMs += 1_500
    await h.actions.runDue()
    expect(h.actions.get(action.id).status).toBe('succeeded')
    expect(keys).toEqual(['send-1', 'send-1'])
    h.actions.stop()
    h.sessions.close()
  })
})
