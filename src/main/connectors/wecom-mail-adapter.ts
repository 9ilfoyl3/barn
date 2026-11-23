import { z } from 'zod'
import type { ConnectorCapabilityDefinition } from '../../shared/models'
import type { ConnectorAdapter, ConnectorExecutionContext } from './types'

const credentialsSchema = z.object({
  apiKeyOrUrl: z.string().trim().min(1).max(10_000),
})

const WECOM_MAIL_MCP_BASE = 'https://qyapi.weixin.qq.com/mcp/robot-mail'
const MCP_PROTOCOL_VERSION = '2025-03-26'
const MCP_REQUEST_TIMEOUT_MS = 20_000
const REQUIRED_TOOLS = new Set(['mail_search', 'mail_get'])

const TOOL_BY_CAPABILITY: Readonly<Record<string, string>> = {
  'wecomMail.search': 'mail_search',
  'wecomMail.get': 'mail_get',
  'wecomMail.send': 'mail_send',
}

export interface McpToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

export interface WeComMailMcpTransport {
  listTools(endpoint: string, signal?: AbortSignal): Promise<McpToolDefinition[]>
  callTool(endpoint: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

export class WeComMailConnectorAdapter implements ConnectorAdapter {
  readonly kind = 'wecomMail'

  constructor(
    private readonly transport: WeComMailMcpTransport = new StreamableHttpWeComMailMcpTransport(),
  ) {}

  async test(context: ConnectorExecutionContext): Promise<{ message: string }> {
    const endpoint = resolveWeComMailEndpoint(credentialsSchema.parse(context.secrets).apiKeyOrUrl)
    const tools = await this.transport.listTools(endpoint, context.signal)
    const missing = [...REQUIRED_TOOLS].filter((name) => !tools.some((tool) => tool.name === name))
    if (missing.length > 0) {
      throw new Error(`WeCom Mail MCP is missing required tools: ${missing.join(', ')}`)
    }
    const mailTools = tools.filter((tool) => tool.name.startsWith('mail_') || tool.name.startsWith('media_'))
    return { message: `Connected to WeCom Mail MCP with ${mailTools.length} mail tools` }
  }

  async call(
    context: ConnectorExecutionContext,
    capability: ConnectorCapabilityDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const toolName = TOOL_BY_CAPABILITY[capability.id]
    if (toolName === undefined) throw new Error(`Unknown WeCom Mail capability: ${capability.id}`)
    const endpoint = resolveWeComMailEndpoint(credentialsSchema.parse(context.secrets).apiKeyOrUrl)
    return this.transport.callTool(endpoint, toolName, args, context.signal)
  }
}

/** Accept the bare API key shown by WeCom or the full Streamable HTTP URL. */
export function resolveWeComMailEndpoint(value: string): string {
  const input = value.trim()
  if (input.length === 0) throw new Error('WeCom Mail API key or endpoint URL is required')
  const url = /^https?:\/\//iu.test(input)
    ? new URL(input)
    : new URL(`${WECOM_MAIL_MCP_BASE}?apikey=${encodeURIComponent(input)}`)
  if (url.protocol !== 'https:') throw new Error('WeCom Mail MCP endpoint must use HTTPS')
  if (url.hostname !== 'qyapi.weixin.qq.com') throw new Error('WeCom Mail MCP endpoint must use qyapi.weixin.qq.com')
  if (!url.pathname.startsWith('/mcp/')) throw new Error('WeCom Mail endpoint must be a WeCom MCP URL')
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('WeCom Mail endpoint must not embed credentials')
  }
  if ((url.searchParams.get('apikey') ?? '').trim().length === 0) {
    throw new Error('WeCom Mail endpoint is missing its apikey parameter')
  }
  return url.toString()
}

interface McpSession {
  endpoint: string
  headers: Record<string, string>
}

export class StreamableHttpWeComMailMcpTransport implements WeComMailMcpTransport {
  private nextRequestId = 1

  async listTools(endpoint: string, signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const session = await this.openSession(endpoint, signal)
    const result = await this.request(session, 'tools/list', {}, signal)
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error('WeCom Mail MCP returned an invalid tools/list response')
    }
    return result.tools.flatMap((tool): McpToolDefinition[] => {
      if (!isRecord(tool) || typeof tool.name !== 'string') return []
      return [{
        name: tool.name,
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...('inputSchema' in tool ? { inputSchema: tool.inputSchema } : {}),
      }]
    })
  }

  async callTool(
    endpoint: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const session = await this.openSession(endpoint, signal)
    const result = await this.request(session, 'tools/call', { name: toolName, arguments: args }, signal)
    if (!isRecord(result)) throw new Error('WeCom Mail MCP returned an invalid tool result')
    if (result.isError === true) {
      throw new Error(toolErrorMessage(result))
    }
    return result
  }

  private async openSession(endpoint: string, signal?: AbortSignal): Promise<McpSession> {
    const headers: Record<string, string> = {}
    const initializeId = this.nextRequestId++
    const initialize = await this.postJson(endpoint, {
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'barn-desktop', version: '0.1.0' },
      },
    }, headers, signal)
    rememberSessionHeaders(headers, initialize)
    const initialized = await this.readResult(initialize, initializeId)
    const protocolVersion = isRecord(initialized) && typeof initialized.protocolVersion === 'string'
      ? initialized.protocolVersion
      : MCP_PROTOCOL_VERSION
    headers['MCP-Protocol-Version'] = protocolVersion

    const notification = await this.postJson(endpoint, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, headers, signal)
    if (!notification.ok) {
      throw new Error(`WeCom Mail MCP returned HTTP ${notification.status}`)
    }
    await notification.text()
    return { endpoint, headers }
  }

  private async request(
    session: McpSession,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextRequestId++
    const response = await this.postJson(session.endpoint, {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }, session.headers, signal)
    rememberSessionHeaders(session.headers, response)
    return this.readResult(response, id)
  }

  private async postJson(
    endpoint: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': 'Barn-Desktop/0.1.0',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) throw new Error(`WeCom Mail MCP returned HTTP ${response.status}`)
    return response
  }

  private async readResult(response: Response, expectedId: number): Promise<unknown> {
    const payload = await readJsonRpcPayload(response, expectedId)
    if (!isRecord(payload)) throw new Error('WeCom Mail MCP returned an invalid JSON-RPC response')
    if (isRecord(payload.error)) {
      const message = typeof payload.error.message === 'string' ? payload.error.message : 'Unknown MCP error'
      throw new Error(`WeCom Mail MCP rejected the request: ${message}`)
    }
    if (!('result' in payload)) throw new Error('WeCom Mail MCP response did not include a result')
    return payload.result
  }
}

async function readJsonRpcPayload(response: Response, expectedId: number): Promise<unknown> {
  const text = await response.text()
  if (text.trim().length === 0) throw new Error('WeCom Mail MCP returned an empty response')
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const events = parseSseData(text)
    const match = events.find((event) => jsonRpcId(event) === expectedId) ?? events.at(-1)
    if (match === undefined) throw new Error('WeCom Mail MCP returned no matching SSE response')
    return match
  }
  try {
    const payload: unknown = JSON.parse(text)
    if (Array.isArray(payload)) {
      const match = payload.find((entry) => jsonRpcId(entry) === expectedId) ?? payload.at(-1)
      if (match === undefined) throw new Error('WeCom Mail MCP returned an empty JSON-RPC batch')
      return match
    }
    return payload
  } catch (error) {
    throw new Error('WeCom Mail MCP returned invalid JSON', { cause: error })
  }
}

function parseSseData(text: string): unknown[] {
  const messages: unknown[] = []
  let dataLines: string[] = []
  const flush = (): void => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data === '[DONE]') return
    try {
      messages.push(JSON.parse(data))
    } catch {
      // Ignore non-JSON SSE events such as keep-alive comments.
    }
  }
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      flush()
      continue
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  flush()
  return messages
}

function jsonRpcId(value: unknown): number | undefined {
  return isRecord(value) && typeof value.id === 'number' ? value.id : undefined
}

function rememberSessionHeaders(target: Record<string, string>, response: Response): void {
  const sessionId = response.headers.get('mcp-session-id')
  if (sessionId !== null && sessionId.length > 0) target['Mcp-Session-Id'] = sessionId
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const cookies = getSetCookie?.call(response.headers) ?? []
  if (cookies.length > 0) {
    target.Cookie = cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ')
  }
}

function toolErrorMessage(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return 'WeCom Mail MCP tool call failed'
  const text = result.content.flatMap((entry): string[] => (
    isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
  )).join('\n').trim()
  return text.length > 0 ? text : 'WeCom Mail MCP tool call failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
