export type AgentComputerProviderId = 'built-in-browser' | 'secure-vm' | 'host-computer'
export type AgentComputerProviderKind = 'browser' | 'desktop'
export type AgentComputerIsolation = 'browser-session' | 'virtual-machine' | 'host-permissions'

export interface AgentComputerProviderCapability {
  id: AgentComputerProviderId
  label: string
  kind: AgentComputerProviderKind
  isolation: AgentComputerIsolation
  available: boolean
  reason?: string | undefined
}

export interface AgentComputerCapabilities {
  defaultProvider: AgentComputerProviderId
  providers: AgentComputerProviderCapability[]
}

/** The shared boundary future Secure VM and host Computer Use providers implement. */
export interface AgentComputerProvider {
  readonly capability: AgentComputerProviderCapability
  startSession(input: { sessionId: string }): Promise<{ computerSessionId: string }>
  stopSession(computerSessionId: string): Promise<void>
}

export function getAgentComputerCapabilities(): AgentComputerCapabilities {
  return {
    defaultProvider: 'built-in-browser',
    providers: [
      {
        id: 'built-in-browser',
        label: 'Built-in Browser',
        kind: 'browser',
        isolation: 'browser-session',
        available: true,
      },
      {
        id: 'secure-vm',
        label: 'Secure VM',
        kind: 'desktop',
        isolation: 'virtual-machine',
        available: false,
        reason: 'Secure VM runtime is not installed. The provider boundary is ready for an on-demand signed VM image.',
      },
      {
        id: 'host-computer',
        label: 'Your Computer',
        kind: 'desktop',
        isolation: 'host-permissions',
        available: false,
        reason: 'Host Computer Use requires macOS Screen Recording, Accessibility, and a dedicated approval flow.',
      },
    ],
  }
}
