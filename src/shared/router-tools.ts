import type { ToolExecutionResult } from './agent-protocol'

/** One ordinary business tool the Router may call through its stable `call` envelope. */
export interface RouterToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface RouterToolExecutionContext {
  workingDirectory?: string | undefined
  signal?: AbortSignal | undefined
}

/** Host-owned dispatch for Router tools. The Router never imports connector secrets or Worker state. */
export interface RouterToolGateway {
  listTools(): RouterToolDescriptor[]
  execute(
    toolName: string,
    argumentsValue: Record<string, unknown>,
    context: RouterToolExecutionContext,
  ): Promise<ToolExecutionResult>
}
