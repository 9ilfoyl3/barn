import { describe, expect, it, vi } from 'vitest'
import { EMAIL_CONNECTOR } from '../../src/main/connectors/catalog'
import { EmailConnectorAdapter, type EmailTransport } from '../../src/main/connectors/email-adapter'
import type { ConnectorCapabilityDefinition } from '../../src/shared/models'

const config = {
  emailAddress: 'person@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpSecure: true,
  fromName: 'Person',
}
const secrets = { username: 'person@example.com', password: 'app-password' }
const connector = {
  id: 'connector-1',
  kind: 'email',
  name: 'Work mail',
  enabled: true,
  config,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function capability(id: string): ConnectorCapabilityDefinition {
  const found = EMAIL_CONNECTOR.capabilities.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`Missing capability ${id}`)
  return found
}

describe('EmailConnectorAdapter', () => {
  it('lists and searches with bounded inputs', async () => {
    const transport: EmailTransport = {
      test: vi.fn(async () => undefined),
      list: vi.fn(async () => [{ uid: 7, subject: 'Hello', from: ['a@example.com'], to: ['b@example.com'], flags: [] }]),
      search: vi.fn(async () => []),
      read: vi.fn(async () => ({ uid: 7, subject: 'Hello', from: [], to: [], cc: [], text: 'Body', truncated: false, attachments: [] })),
      send: vi.fn(async () => ({ messageId: 'id', accepted: [], rejected: [] })),
    }
    const adapter = new EmailConnectorAdapter(transport)
    const result = await adapter.call({ connector, secrets }, capability('email.list'), { limit: 5 })
    expect(result).toEqual([{ uid: 7, subject: 'Hello', from: ['a@example.com'], to: ['b@example.com'], flags: [] }])
    expect(transport.list).toHaveBeenCalledWith(expect.objectContaining({ config }), 'INBOX', 5)
    await expect(adapter.call({ connector, secrets }, capability('email.search'), { query: 'invoice' }))
      .resolves.toEqual([])
    expect(transport.search).toHaveBeenCalledWith(expect.anything(), 'INBOX', 'invoice', 20)
  })

  it('sends through transport and forwards idempotency', async () => {
    const transport: EmailTransport = {
      test: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async () => ({ uid: 1, subject: '', from: [], to: [], cc: [], text: '', truncated: false, attachments: [] })),
      send: vi.fn(async () => ({ messageId: 'message-id', accepted: ['client@example.com'], rejected: [] })),
    }
    const adapter = new EmailConnectorAdapter(transport)
    await expect(adapter.call({
      connector,
      secrets,
      idempotencyKey: 'stable-key',
    }, capability('email.send'), {
      to: 'client@example.com',
      subject: 'Report',
      text: 'Attached is the report.',
    })).resolves.toEqual({
      messageId: 'message-id',
      accepted: ['client@example.com'],
      rejected: [],
    })
    expect(transport.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subject: 'Report' }),
      'stable-key',
    )
  })

  it('rejects incomplete connection settings and write bodies', async () => {
    const transport: EmailTransport = {
      test: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async () => ({ uid: 1, subject: '', from: [], to: [], cc: [], text: '', truncated: false, attachments: [] })),
      send: vi.fn(async () => ({ messageId: 'id', accepted: [], rejected: [] })),
    }
    const adapter = new EmailConnectorAdapter(transport)
    await expect(adapter.call({
      connector: { ...connector, config: { emailAddress: 'person@example.com' } },
      secrets,
    }, capability('email.list'), {})).rejects.toThrow()
    await expect(adapter.call({ connector, secrets }, capability('email.send'), {
      to: 'client@example.com',
      subject: 'No body',
    })).rejects.toThrow('body')
  })
})
