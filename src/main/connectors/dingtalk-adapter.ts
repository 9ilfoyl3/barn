import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorCapabilityDefinition } from '../../shared/models'
import type { ConnectorAdapter, ConnectorExecutionContext } from './types'

const configSchema = z.object({
  keyword: z.string().trim().max(100).optional(),
})

const credentialsSchema = z.object({
  webhookUrl: z.string().trim().url().max(4_000),
  secret: z.string().trim().min(1).max(500).optional(),
})

const sendArgsSchema = z.object({
  text: z.string().trim().min(1).max(20_000).optional(),
  markdown: z.object({
    title: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(20_000),
  }).strict().optional(),
  atMobiles: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  atAll: z.boolean().optional(),
}).strict().refine((value) => (value.text === undefined) !== (value.markdown === undefined), {
  message: 'Provide exactly one of text or markdown',
})

export interface DingTalkSendResult {
  errcode: number
  errmsg: string
}

export interface DingTalkTransport {
  send(url: string, body: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal): Promise<DingTalkSendResult>
}

interface DingTalkConnection {
  config: z.infer<typeof configSchema>
  credentials: z.infer<typeof credentialsSchema>
  signal?: AbortSignal
}

export class DingTalkConnectorAdapter implements ConnectorAdapter {
  readonly kind = 'dingtalk'

  constructor(private readonly transport: DingTalkTransport = createDingTalkTransport()) {}

  async test(context: ConnectorExecutionContext): Promise<{ message: string }> {
    const connection = parseConnection(context)
    const keyword = connection.config.keyword === undefined ? '' : ` ${connection.config.keyword}`
    const result = await this.transport.send(
      signedWebhookUrl(connection.credentials.webhookUrl, connection.credentials.secret),
      {
        msgtype: 'text',
        text: { content: `Barn 连接测试${keyword}` },
      },
    )
    assertDingTalkSuccess(result)
    return { message: 'Connected to the DingTalk robot' }
  }

  async call(
    context: ConnectorExecutionContext,
    capability: ConnectorCapabilityDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (capability.id !== 'dingtalk.send') throw new Error(`Unknown DingTalk capability: ${capability.id}`)
    const connection = parseConnection(context)
    const input = sendArgsSchema.parse(args)
    const keyword = connection.config.keyword
    const body = input.markdown === undefined
      ? {
          msgtype: 'text',
          text: { content: appendKeyword(input.text ?? '', keyword) },
        }
      : {
          msgtype: 'markdown',
          markdown: {
            title: input.markdown.title,
            text: appendKeyword(input.markdown.text, keyword),
          },
        }
    if (input.atMobiles !== undefined || input.atAll !== undefined) {
      Object.assign(body, {
        at: {
          ...(input.atMobiles === undefined ? {} : { atMobiles: input.atMobiles }),
          ...(input.atAll === undefined ? {} : { isAtAll: input.atAll }),
        },
      })
    }
    const result = await this.transport.send(
      signedWebhookUrl(connection.credentials.webhookUrl, connection.credentials.secret),
      body,
      context.idempotencyKey,
      context.signal,
    )
    assertDingTalkSuccess(result)
    return result
  }
}

function parseConnection(context: ConnectorExecutionContext): DingTalkConnection {
  const config = configSchema.parse(context.connector.config)
  const credentials = credentialsSchema.parse(context.secrets)
  validateWebhook(credentials.webhookUrl)
  return {
    config,
    credentials,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  }
}

export function signedWebhookUrl(webhookUrl: string, secret: string | undefined, now = Date.now()): string {
  validateWebhook(webhookUrl)
  if (secret === undefined || secret.trim().length === 0) return webhookUrl
  const timestamp = String(now)
  const sign = createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64')
  const url = new URL(webhookUrl)
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('sign', sign)
  return url.toString()
}

function validateWebhook(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('DingTalk webhook must use HTTPS')
  if (!url.pathname.includes('/robot/send')) throw new Error('DingTalk webhook must be a robot/send endpoint')
  if (url.username.length > 0 || url.password.length > 0) throw new Error('DingTalk webhook must not embed credentials')
}

function appendKeyword(value: string, keyword: string | undefined): string {
  if (keyword === undefined || keyword.trim().length === 0 || value.includes(keyword)) return value
  return `${value}\n${keyword}`
}

function assertDingTalkSuccess(result: DingTalkSendResult): void {
  if (result.errcode !== 0) throw new Error(`DingTalk rejected the message: ${result.errmsg || result.errcode}`)
}

export function createDingTalkTransport(): DingTalkTransport {
  return {
    async send(url, body, idempotencyKey, signal) {
      const timeout = AbortSignal.timeout(20_000)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey === undefined ? {} : { 'X-Barn-Idempotency-Key': idempotencyKey }),
        },
        body: JSON.stringify(body),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      if (!response.ok) throw new Error(`DingTalk webhook returned HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (!isRecord(payload) || typeof payload.errcode !== 'number') {
        throw new Error('DingTalk webhook returned an invalid response')
      }
      return {
        errcode: payload.errcode,
        errmsg: typeof payload.errmsg === 'string' ? payload.errmsg : '',
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
