import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DINGTALK_CONNECTOR, EMAIL_CONNECTOR } from '../../src/main/connectors/catalog'
import { ConnectorCredentialStore } from '../../src/main/connectors/connector-credentials'
import { ConnectorService } from '../../src/main/connectors/connector-service'
import type { ConnectorAdapter } from '../../src/main/connectors/types'
import type { ActionRecord, ActionRequestInput } from '../../src/main/actions/types'
import type { ConnectorConfig, ConnectorDefinition } from '../../src/shared/models'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import type { SecretCodec } from '../../src/main/models/credential-store'

class TestCodec implements SecretCodec {
  async encrypt(value: string): Promise<string> {
    return Buffer.from(value).toString('base64')
  }

  async decrypt(value: string): Promise<string> {
    return Buffer.from(value, 'base64').toString('utf8')
  }
}

const config = {
  emailAddress: 'person@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpSecure: true,
}

async function harness(options: {
  definition?: ConnectorDefinition
  config?: ConnectorConfig
  credentials?: Record<string, string>
  name?: string
} = {}) {
  const definition = options.definition ?? EMAIL_CONNECTOR
  const connectorConfig = options.config ?? config
  const connectorCredentials = options.credentials ?? { username: 'person@example.com', password: 'app-password' }
  const directory = await mkdtemp(join(tmpdir(), 'barn-connector-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const credentials = new ConnectorCredentialStore(join(directory, 'credentials.enc'), new TestCodec())
  const adapter: ConnectorAdapter = {
    kind: definition.kind,
    test: vi.fn(async () => ({ message: 'connected' })),
    call: vi.fn(async (_context, capability) => ({ capability: capability.id })),
  }
  const enqueued: ActionRequestInput[] = []
  const listedActions: ActionRecord[] = []
  const handlers = new Map<string, (action: ActionRecord, context: { actionId: string; idempotencyKey: string; signal: AbortSignal }) => Promise<unknown>>()
  const actions = {
    list: () => listedActions,
    enqueue(input: ActionRequestInput): ActionRecord {
      enqueued.push(input)
      const action: ActionRecord = {
        id: randomUUID(),
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        summary: input.summary,
        status: 'pending_approval',
        payload: input.payload,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      listedActions.unshift(action)
      return action
    },
    registerHandler(handler: { kind: string; execute: (action: ActionRecord, context: { actionId: string; idempotencyKey: string; signal: AbortSignal }) => Promise<unknown> }) {
      handlers.set(handler.kind, handler.execute)
    },
    retry(actionId: string): ActionRecord {
      const action = listedActions.find((entry) => entry.id === actionId)
      if (action === undefined) throw new Error('missing action')
      const next = { ...action, status: 'queued' as const, updatedAt: new Date().toISOString() }
      const index = listedActions.findIndex((entry) => entry.id === actionId)
      listedActions[index] = next
      return next
    },
    cancel(actionId: string): ActionRecord {
      const action = listedActions.find((entry) => entry.id === actionId)
      if (action === undefined) throw new Error('missing action')
      const next = { ...action, status: 'cancelled' as const, updatedAt: new Date().toISOString() }
      const index = listedActions.findIndex((entry) => entry.id === actionId)
      listedActions[index] = next
      return next
    },
  }
  const service = new ConnectorService(
    sessions.connectors,
    credentials,
    () => actions,
    () => ({ request: () => ({ decision: 'allowed' as const }) }),
    { definitions: new Map([[definition.kind, definition]]), adapters: [adapter] },
  )
  const connector = await service.create({ kind: definition.kind, name: options.name ?? 'Work mail', config: connectorConfig })
  if (Object.keys(connectorCredentials).length > 0) {
    await service.saveCredentials({ connectorId: connector.id, values: connectorCredentials })
  }
  return { directory, sessions, credentials, adapter, service, actions, handlers, enqueued, listedActions, connector }
}

describe('ConnectorService', () => {
  it('reports readiness and tests the adapter', async () => {
    const h = await harness()
    expect(await h.service.list()).toEqual([
      expect.objectContaining({ id: h.connector.id, configured: true, status: 'ready' }),
    ])
    await expect(h.service.test(h.connector.id)).resolves.toMatchObject({
      ok: true,
      message: 'connected',
    })
    h.sessions.close()
  })

  it('executes read capabilities directly', async () => {
    const h = await harness()
    const result = await h.service.call({
      connectorId: h.connector.id,
      capability: 'email.list',
      arguments: { limit: 5 },
    })
    expect(result).toEqual({ kind: 'result', value: { capability: 'email.list' } })
    expect(h.adapter.call).toHaveBeenCalledWith(
      expect.objectContaining({ connector: expect.objectContaining({ id: h.connector.id }) }),
      expect.objectContaining({ id: 'email.list' }),
      { limit: 5 },
    )
    h.sessions.close()
  })

  it('queues external writes instead of executing them', async () => {
    const h = await harness()
    const taskId = randomUUID()
    const result = await h.service.call({
      connectorId: h.connector.id,
      capability: 'email.send',
      arguments: { to: 'client@example.com', subject: 'Hello', text: 'Body' },
    }, { sessionId: 'session-1', taskId })
    expect(result).toMatchObject({ kind: 'action', status: 'pending_approval' })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toMatchObject({
      kind: 'connector.effect',
      permissionKind: 'external-write',
      taskId,
      payload: expect.objectContaining({ connectorId: h.connector.id, capability: 'email.send' }),
    })
    expect(h.adapter.call).not.toHaveBeenCalled()
    expect(h.service.listActions()).toEqual([
      expect.objectContaining({ title: 'Send mail', status: 'pending_approval', attempts: 0 }),
    ])
    h.sessions.close()
  })

  it('executes explicitly direct-write capabilities without an approval action', async () => {
    const h = await harness({
      definition: DINGTALK_CONNECTOR,
      config: {},
      credentials: {},
      name: 'DingTalk',
    })
    const result = await h.service.call({
      connectorId: h.connector.id,
      capability: 'dingtalk.send',
      arguments: { userId: 'user-1', content: 'Hello' },
    })

    expect(result).toEqual({ kind: 'result', value: { capability: 'dingtalk.send' } })
    expect(h.enqueued).toHaveLength(0)
    expect(h.adapter.call).toHaveBeenCalledWith(
      expect.objectContaining({ connector: expect.objectContaining({ id: h.connector.id }) }),
      expect.objectContaining({ id: 'dingtalk.send', requiresApproval: false }),
      { userId: 'user-1', content: 'Hello' },
    )
    h.sessions.close()
  })

  it('retries or cancels an unknown-effect connector action explicitly', async () => {
    const h = await harness()
    h.listedActions.unshift({
      id: 'unknown-action',
      kind: 'connector.effect',
      idempotencyKey: 'unknown-key',
      title: 'Send mail',
      summary: 'Send the report.',
      status: 'unknown_effect',
      payload: {},
      attempts: 1,
      maxAttempts: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await expect(h.service.retryAction('unknown-action')).resolves.toMatchObject({ status: 'queued' })
    h.listedActions[0] = { ...h.listedActions[0]!, status: 'unknown_effect' }
    await expect(h.service.cancelAction('unknown-action')).resolves.toMatchObject({ status: 'cancelled' })
    h.sessions.close()
  })

  it('executes a claimed action through the adapter with its stable idempotency key', async () => {
    const h = await harness()
    h.service.registerActionHandler(h.actions)
    const execute = h.handlers.get('connector.effect')
    expect(execute).toBeDefined()
    await execute!({
      id: 'action-1',
      kind: 'connector.effect',
      idempotencyKey: 'stable-key',
      title: 'Send',
      summary: 'Send mail',
      status: 'running',
      payload: {
        connectorId: h.connector.id,
        capability: 'email.send',
        arguments: { to: 'client@example.com', subject: 'Hello', text: 'Body' },
      },
      attempts: 1,
      maxAttempts: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      actionId: 'action-1',
      idempotencyKey: 'stable-key',
      signal: new AbortController().signal,
    })
    expect(h.adapter.call).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'stable-key' }),
      expect.objectContaining({ id: 'email.send' }),
      expect.anything(),
    )
    h.sessions.close()
  })
})
