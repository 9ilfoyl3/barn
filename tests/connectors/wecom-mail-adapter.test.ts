import { createServer, type Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { WECOM_MAIL_CONNECTOR } from '../../src/main/connectors/catalog'
import {
  resolveWeComMailEndpoint,
  StreamableHttpWeComMailMcpTransport,
  WeComMailConnectorAdapter,
  type WeComMailMcpTransport,
} from '../../src/main/connectors/wecom-mail-adapter'
import type { ConnectorRecord } from '../../src/main/connectors/types'

const connector: ConnectorRecord = {
  id: 'connector-1',
  kind: 'wecomMail',
  name: '企业微信邮件',
  enabled: true,
  config: {},
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
}

function capability(id: string) {
  const found = WECOM_MAIL_CONNECTOR.capabilities.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`Missing capability ${id}`)
  return found
}

describe('WeCom Mail connector', () => {
  it('accepts a bare apikey or a full WeCom Mail MCP URL', () => {
    expect(resolveWeComMailEndpoint('abc-123')).toBe(
      'https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=abc-123',
    )
    expect(resolveWeComMailEndpoint('https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=full-key')).toBe(
      'https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=full-key',
    )
  })

  it('does not send credentials to arbitrary hosts', () => {
    expect(() => resolveWeComMailEndpoint('https://example.com/mcp/robot-mail?apikey=secret')).toThrow(
      'qyapi.weixin.qq.com',
    )
    expect(() => resolveWeComMailEndpoint('http://qyapi.weixin.qq.com/mcp/robot-mail?apikey=secret')).toThrow(
      'HTTPS',
    )
  })

  it('maps Barn capabilities to the official mail tools', async () => {
    const transport: WeComMailMcpTransport = {
      listTools: vi.fn(async () => [
        { name: 'mail_search' },
        { name: 'mail_get' },
        { name: 'mail_send' },
      ]),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    }
    const adapter = new WeComMailConnectorAdapter(transport)
    await expect(adapter.test({ connector, secrets: { apiKeyOrUrl: 'test-key' } })).resolves.toEqual({
      message: 'Connected to WeCom Mail MCP with 3 mail tools',
    })
    await adapter.call(
      { connector, secrets: { apiKeyOrUrl: 'test-key' } },
      capability('wecomMail.search'),
      { keyword: 'report', limit: 10 },
    )
    expect(transport.callTool).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=test-key',
      'mail_search',
      { keyword: 'report', limit: 10 },
      undefined,
    )
    await adapter.call(
      { connector, secrets: { apiKeyOrUrl: 'test-key' } },
      capability('wecomMail.send'),
      { to: ['person@example.com'], subject: 'Report', content: 'Ready' },
    )
    expect(transport.callTool).toHaveBeenLastCalledWith(
      'https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=test-key',
      'mail_send',
      { to: ['person@example.com'], subject: 'Report', content: 'Ready' },
      undefined,
    )
  })

  it('initializes a Streamable HTTP session and reads JSON and SSE tool responses', async () => {
    const requests: Array<{ method: string; session?: string; protocol?: string }> = []
    const server = await startMcpServer(requests)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Server did not bind')
      const endpoint = `http://127.0.0.1:${address.port}/mcp/robot-mail?apikey=test-key`
      const transport = new StreamableHttpWeComMailMcpTransport()
      await expect(transport.listTools(endpoint)).resolves.toEqual([
        expect.objectContaining({ name: 'mail_search' }),
        expect.objectContaining({ name: 'mail_get' }),
      ])
      await expect(transport.callTool(endpoint, 'mail_search', { keyword: 'report' })).resolves.toMatchObject({
        content: [expect.objectContaining({ type: 'text' })],
      })
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'initialize' }),
        expect.objectContaining({ method: 'notifications/initialized', session: 'session-1', protocol: '2025-03-26' }),
        expect.objectContaining({ method: 'tools/list', session: 'session-1', protocol: '2025-03-26' }),
        expect.objectContaining({ method: 'tools/call', session: 'session-1', protocol: '2025-03-26' }),
      ]))
    } finally {
      await closeServer(server)
    }
  })
})

async function startMcpServer(requests: Array<{ method: string; session?: string; protocol?: string }>): Promise<Server> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { id?: number; method: string }
      requests.push({
        method: payload.method,
        ...(request.headers['mcp-session-id'] === undefined ? {} : { session: String(request.headers['mcp-session-id']) }),
        ...(request.headers['mcp-protocol-version'] === undefined ? {} : { protocol: String(request.headers['mcp-protocol-version']) }),
      })
      if (payload.method === 'initialize') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'session-1',
        })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'wecom-mail-test', version: '1.0.0' },
          },
        }))
        return
      }
      if (payload.method === 'notifications/initialized') {
        response.writeHead(202).end()
        return
      }
      if (payload.method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            tools: [
              { name: 'mail_search', description: 'Search mail' },
              { name: 'mail_get', description: 'Read mail' },
            ],
          },
        })}\n\n`)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: '{"mails":[]}' }] },
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
}
