import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSandboxPolicy } from '../../src/main/sandbox/policy'
import { ShellService } from '../../src/main/sandbox/shell-service'

describe.skipIf(process.platform !== 'darwin')('macOS sandboxed shell', () => {
  it('writes only inside allowed roots and scrubs credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'barn-shell-'))
    const workspace = join(root, 'workspace')
    const output = join(root, 'output')
    const privateTemp = join(root, 'private-temp')
    const outside = join(root, 'outside.txt')
    const { mkdir } = await import('node:fs/promises')
    await Promise.all([
      mkdir(workspace),
      mkdir(output),
      mkdir(privateTemp),
    ])

    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: privateTemp,
      timeoutMs: 10_000,
    })
    const service = new ShellService()
    const result = await service.run({
      command: `printf allowed > ${JSON.stringify(join(output, 'allowed.txt'))}; printf blocked > ${JSON.stringify(outside)} || true`,
      cwd: workspace,
      policy,
    })

    expect(result.sandbox.backend).toBe('macos-seatbelt')
    expect(await readFile(join(output, 'allowed.txt'), 'utf8')).toBe('allowed')
    await expect(access(outside)).rejects.toThrow()
  })
})
