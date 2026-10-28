import type { RuntimeCapabilities } from '../../shared/models'
import type { ShellService } from '../sandbox/shell-service'

export function getRuntimeCapabilities(shell: ShellService): RuntimeCapabilities {
  return {
    platform: process.platform,
    shell: shell.capability(),
  }
}
