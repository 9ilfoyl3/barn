export type SandboxMode = 'read-only' | 'output-write' | 'workspace-write'

export interface SandboxPolicy {
  mode: SandboxMode
  workspaceRoot: string
  outputRoot: string
  privateTempRoot: string
  readRoots: string[]
  writeRoots: string[]
  denyPaths: string[]
  network: 'deny'
  timeoutMs: number
  maxOutputBytes: number
}

export interface ShellRequest {
  command: string
  cwd: string
  policy: SandboxPolicy
  signal?: AbortSignal
}

export interface ShellResult {
  command: string
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  sandbox: {
    backend: string
    mode: SandboxMode
  }
}

export interface ShellCapability {
  available: boolean
  backend: string
  reason?: string
}
