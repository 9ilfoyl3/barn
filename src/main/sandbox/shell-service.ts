import { macosShellCapability, runMacosSeatbelt } from './macos-seatbelt'
import type { ShellCapability, ShellRequest, ShellResult } from './types'

export class ShellService {
  capability(): ShellCapability {
    return macosShellCapability()
  }

  async run(request: ShellRequest): Promise<ShellResult> {
    if (process.platform === 'darwin') return runMacosSeatbelt(request)
    const capability = this.capability()
    throw new Error(capability.reason ?? 'Sandboxed shell is unavailable on this platform')
  }
}
