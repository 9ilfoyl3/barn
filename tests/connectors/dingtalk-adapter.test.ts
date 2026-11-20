import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DINGTALK_CONNECTOR } from '../../src/main/connectors/catalog'
import {
  DingTalkConnectorAdapter,
  signedWebhookUrl,
  type DingTalkTransport,
} from '../../src/main/connectors/dingtalk-adapter'

const webhookUrl = 'https://oapi.dingtalk.com/robot/send?access_token=token'
const connector = {
  id: 'dingtalk-1',
  kind: 'dingtalk',
  name: 'Team robot',
  enabled: true,
  config: { keyword: 'Barn' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const secrets = { webhookUrl, secret: 'secret-value' }
const sendCapability = DINGTALK_CONNECTOR.capabilities.find((entry) => entry.id === 'dingtalk.send')
if (sendCapability === undefined) throw new Error('DingTalk send capability is missing')

describe('DingTalkConnectorAdapter', () => {
  it('signs robot webhooks with the documented timestamp and HMAC scheme', () => {
    const signed = new URL(signedWebhookUrl(webhookUrl, 'secret-value', 1_700_000_000_000))
    const timestamp = signed.searchParams.get('timestamp')
    const sign = signed.searchParams.get('sign')
    expect(timestamp).toBe('1700000000000')
    expect(sign).toBe(createHmac('sha256', 'secret-value')
      .update('1700000000000\nsecret-value')
      .digest('base64'))
    expect(signed.searchParams.get('access_token')).toBe('token')
  })

  it('sends text with a configured keyword and idempotency key', async () => {
    const transport: DingTalkTransport = {
      send: vi.fn(async () => ({ errcode: 0, errmsg: 'ok' })),
    }
    const adapter = new DingTalkConnectorAdapter(transport)
    await expect(adapter.call({
      connector,
      secrets,
      idempotencyKey: 'stable-key',
    }, sendCapability, {
      text: 'Build finished',
      atMobiles: ['13800000000'],
    })).resolves.toEqual({ errcode: 0, errmsg: 'ok' })
    expect(transport.send).toHaveBeenCalledWith(
      expect.stringContaining('timestamp='),
      {
        msgtype: 'text',
        text: { content: 'Build finished\nBarn' },
        at: { atMobiles: ['13800000000'] },
      },
      'stable-key',
      undefined,
    )
  })

  it('sends a markdown test message without duplicates', async () => {
    const transport: DingTalkTransport = {
      send: vi.fn(async () => ({ errcode: 0, errmsg: 'ok' })),
    }
    const adapter = new DingTalkConnectorAdapter(transport)
    await expect(adapter.test({ connector, secrets })).resolves.toEqual({
      message: 'Connected to the DingTalk robot',
    })
    expect(transport.send).toHaveBeenCalledWith(
      expect.stringContaining('sign='),
      {
        msgtype: 'text',
        text: { content: 'Barn 连接测试 Barn' },
      },
    )
  })

  it('rejects non-HTTPS and non-robot webhook URLs', async () => {
    const transport: DingTalkTransport = {
      send: vi.fn(async () => ({ errcode: 0, errmsg: 'ok' })),
    }
    const adapter = new DingTalkConnectorAdapter(transport)
    await expect(adapter.call({
      connector,
      secrets: { webhookUrl: 'http://oapi.dingtalk.com/robot/send?access_token=x' },
    }, sendCapability, { text: 'Hello' })).rejects.toThrow('HTTPS')
    await expect(adapter.call({
      connector,
      secrets: { webhookUrl: 'https://example.com/hook' },
    }, sendCapability, { text: 'Hello' })).rejects.toThrow('robot/send endpoint')
  })

  it('surfaces DingTalk error responses', async () => {
    const transport: DingTalkTransport = {
      send: vi.fn(async () => ({ errcode: 310000, errmsg: 'keywords not in content' })),
    }
    const adapter = new DingTalkConnectorAdapter(transport)
    await expect(adapter.call({ connector, secrets }, sendCapability, { text: 'Hello' }))
      .rejects.toThrow('keywords not in content')
  })
})
