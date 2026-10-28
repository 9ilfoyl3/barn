import { describe, expect, it } from 'vitest'
import { getRuntimeCapabilities } from '../src/main/platform/runtime-capabilities'
import { ShellService } from '../src/main/sandbox/shell-service'

describe('runtime capabilities', () => {
  it('reports the current platform shell backend without inventing support', () => {
    const capabilities = getRuntimeCapabilities(new ShellService())
    expect(capabilities.platform).toBe(process.platform)
    if (process.platform === 'darwin') {
      expect(capabilities.shell.available).toBe(true)
      expect(capabilities.shell.backend).toBe('macos-seatbelt')
    } else {
      expect(capabilities.shell.available).toBe(false)
    }
  })
})
