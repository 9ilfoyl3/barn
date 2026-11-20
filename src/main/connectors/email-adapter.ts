import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import type { ConnectorCapabilityDefinition } from '../../shared/models'
import type { ConnectorAdapter, ConnectorExecutionContext } from './types'

const configSchema = z.object({
  emailAddress: z.string().trim().email(),
  imapHost: z.string().trim().min(1).max(500),
  imapPort: z.number().int().min(1).max(65_535),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().trim().min(1).max(500),
  smtpPort: z.number().int().min(1).max(65_535),
  smtpSecure: z.boolean().default(true),
  fromName: z.string().trim().max(200).optional(),
})

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(500),
  password: z.string().min(1).max(10_000),
})

const listArgsSchema = z.object({
  mailbox: z.string().trim().min(1).max(500).default('INBOX'),
  limit: z.number().int().min(1).max(50).default(20),
}).strict()

const searchArgsSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  mailbox: z.string().trim().min(1).max(500).default('INBOX'),
  limit: z.number().int().min(1).max(50).default(20),
}).strict()

const readArgsSchema = z.object({
  uid: z.number().int().positive(),
  mailbox: z.string().trim().min(1).max(500).default('INBOX'),
}).strict()

const sendArgsSchema = z.object({
  to: z.union([z.string().trim().email(), z.array(z.string().trim().email()).min(1).max(50)]),
  cc: z.union([z.string().trim().email(), z.array(z.string().trim().email()).max(50)]).optional(),
  bcc: z.union([z.string().trim().email(), z.array(z.string().trim().email()).max(50)]).optional(),
  subject: z.string().trim().min(1).max(500),
  text: z.string().max(500_000).optional(),
  html: z.string().max(1_000_000).optional(),
}).strict().refine((value) => value.text !== undefined || value.html !== undefined, {
  message: 'Email body text or html is required',
})

export interface EmailListEntry {
  uid: number
  subject: string
  from: string[]
  to: string[]
  date?: string
  flags: string[]
  size?: number
  preview?: string
}

export interface EmailReadResult {
  uid: number
  subject: string
  from: string[]
  to: string[]
  cc: string[]
  date?: string
  messageId?: string
  text: string
  truncated: boolean
  attachments: Array<{ filename: string; size: number; contentType?: string }>
}

export interface EmailSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

export interface EmailTransport {
  test(context: EmailConnection): Promise<void>
  list(context: EmailConnection, mailbox: string, limit: number): Promise<EmailListEntry[]>
  search(context: EmailConnection, mailbox: string, query: string, limit: number): Promise<EmailListEntry[]>
  read(context: EmailConnection, mailbox: string, uid: number): Promise<EmailReadResult>
  send(
    context: EmailConnection,
    message: z.infer<typeof sendArgsSchema>,
    idempotencyKey?: string,
  ): Promise<EmailSendResult>
}

interface EmailConnection {
  config: z.infer<typeof configSchema>
  credentials: z.infer<typeof credentialsSchema>
  signal?: AbortSignal
}

const MAX_BODY_CHARS = 100_000
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024

export class EmailConnectorAdapter implements ConnectorAdapter {
  readonly kind = 'email'

  constructor(private readonly transport: EmailTransport = createEmailTransport()) {}

  async test(context: ConnectorExecutionContext): Promise<{ message: string }> {
    const connection = parseConnection(context)
    await this.transport.test(connection)
    return { message: `Connected to ${connection.config.imapHost} as ${connection.config.emailAddress}` }
  }

  async call(
    context: ConnectorExecutionContext,
    capability: ConnectorCapabilityDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const connection = parseConnection(context)
    switch (capability.id) {
      case 'email.list': {
        const input = listArgsSchema.parse(args)
        return this.transport.list(connection, input.mailbox, input.limit)
      }
      case 'email.search': {
        const input = searchArgsSchema.parse(args)
        return this.transport.search(connection, input.mailbox, input.query, input.limit)
      }
      case 'email.read': {
        const input = readArgsSchema.parse(args)
        return this.transport.read(connection, input.mailbox, input.uid)
      }
      case 'email.send': {
        const input = sendArgsSchema.parse(args)
        return this.transport.send(connection, input, context.idempotencyKey)
      }
      default:
        throw new Error(`Unknown email capability: ${capability.id}`)
    }
  }
}

function parseConnection(context: ConnectorExecutionContext): EmailConnection {
  const config = configSchema.parse(context.connector.config)
  const credentials = credentialsSchema.parse(context.secrets)
  return {
    config,
    credentials,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  }
}

export function createEmailTransport(): EmailTransport {
  return {
    async test(connection) {
      const client = imapClient(connection)
      try {
        await client.connect()
      } finally {
        if (client.usable) await client.logout().catch(() => undefined)
      }
    },

    async list(connection, mailbox, limit) {
      return withMailbox(connection, mailbox, async (client) => {
        const mailboxState = client.mailbox
        if (mailboxState === false) throw new Error(`Mailbox ${mailbox} could not be opened`)
        const exists = mailboxState.exists
        if (exists === 0) return []
        const start = Math.max(1, exists - limit + 1)
        return readEnvelopes(client, `${start}:*`, false, limit)
      })
    },

    async search(connection, mailbox, query, limit) {
      return withMailbox(connection, mailbox, async (client) => {
        const results = await client.search({ text: query }, { uid: true })
        if (results === false || results === undefined || results.length === 0) return []
        return readEnvelopes(client, results.slice(-limit).join(','), true, limit)
      })
    },

    async read(connection, mailbox, uid) {
      return withMailbox(connection, mailbox, async (client) => {
        const metadata = await client.fetchOne(String(uid), {
          uid: true,
          size: true,
          envelope: true,
          internalDate: true,
        }, { uid: true })
        if (metadata === false) throw new Error(`Email UID ${uid} was not found`)
        if ((metadata.size ?? 0) > MAX_MESSAGE_BYTES) {
          throw new Error(`Email UID ${uid} is too large to read safely`)
        }
        const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
        if (message === false || message.source === undefined) throw new Error(`Email UID ${uid} was not found`)
        const parsed = await simpleParser(message.source)
        const rawText = parsed.text ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')
        const text = rawText.slice(0, MAX_BODY_CHARS)
        return {
          uid,
          subject: parsed.subject ?? metadata.envelope?.subject ?? '',
          from: addresses(parsed.from),
          to: addresses(parsed.to),
          cc: addresses(parsed.cc),
          ...(parsed.date === undefined ? {} : { date: parsed.date.toISOString() }),
          ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
          text,
          truncated: rawText.length > text.length,
          attachments: parsed.attachments.map((attachment) => ({
            filename: attachment.filename ?? 'attachment',
            size: attachment.size,
            ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
          })),
        } satisfies EmailReadResult
      })
    },

    async send(connection, message, idempotencyKey) {
      const transport = nodemailer.createTransport({
        host: connection.config.smtpHost,
        port: connection.config.smtpPort,
        secure: connection.config.smtpSecure,
        auth: {
          user: connection.credentials.username,
          pass: connection.credentials.password,
        },
      })
      const info = await transport.sendMail({
        from: {
          name: connection.config.fromName ?? connection.config.emailAddress,
          address: connection.config.emailAddress,
        },
        to: message.to,
        ...(message.cc === undefined ? {} : { cc: message.cc }),
        ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
        subject: message.subject,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.html === undefined ? {} : { html: message.html }),
        headers: idempotencyKey === undefined ? undefined : { 'X-Barn-Idempotency-Key': idempotencyKey },
      })
      return {
        messageId: info.messageId,
        accepted: (info.accepted as Array<string | { address: string }>).map(addressText),
        rejected: (info.rejected as Array<string | { address: string }>).map(addressText),
      }
    },
  }
}

function imapClient(connection: EmailConnection): ImapFlow {
  return new ImapFlow({
    host: connection.config.imapHost,
    port: connection.config.imapPort,
    secure: connection.config.imapSecure,
    auth: {
      user: connection.credentials.username,
      pass: connection.credentials.password,
    },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  })
}

async function withMailbox<T>(
  connection: EmailConnection,
  mailbox: string,
  operation: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  if (connection.signal?.aborted) throw new Error('Email operation was cancelled')
  const client = imapClient(connection)
  try {
    await client.connect()
    await client.mailboxOpen(mailbox, { readOnly: true })
    return await operation(client)
  } finally {
    if (client.usable) await client.logout().catch(() => undefined)
  }
}

async function readEnvelopes(
  client: ImapFlow,
  range: string,
  byUid: boolean,
  limit: number,
): Promise<EmailListEntry[]> {
  const entries: EmailListEntry[] = []
  for await (const message of client.fetch(range, {
    uid: true,
    envelope: true,
    internalDate: true,
    flags: true,
    size: true,
  }, { uid: byUid })) {
    entries.push({
      uid: message.uid,
      subject: message.envelope?.subject ?? '',
      from: envelopeAddresses(message.envelope?.from),
      to: envelopeAddresses(message.envelope?.to),
      ...(toIsoDate(message.internalDate) === undefined ? {} : { date: toIsoDate(message.internalDate)! }),
      flags: [...(message.flags ?? [])].toSorted(),
      ...(message.size === undefined ? {} : { size: message.size }),
    })
  }
  return entries.toSorted((left, right) => (right.date ?? '').localeCompare(left.date ?? '')).slice(0, limit)
}

function envelopeAddresses(values: Array<{ name?: string | undefined; address?: string | undefined }> | undefined): string[] {
  return (values ?? []).flatMap((entry) => {
    if (entry.address === undefined) return entry.name === undefined ? [] : [entry.name]
    return [entry.name === undefined ? entry.address : `${entry.name} <${entry.address}>`]
  })
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  if (value === undefined) return []
  const records = Array.isArray(value) ? value : [value]
  return records.flatMap((entry) => entry.value.flatMap((address) => {
    if (address.address === undefined) return address.name === undefined ? [] : [address.name]
    return [address.name === undefined ? address.address : `${address.name} <${address.address}>`]
  }))
}

function toIsoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function addressText(value: string | { address: string }): string {
  return typeof value === 'string' ? value : value.address
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}
