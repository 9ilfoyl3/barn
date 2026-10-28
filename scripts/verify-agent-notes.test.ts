import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Agent Notes tree', () => {
  it('matches the lifecycle and format rules', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-agent-notes.ts'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Agent Notes are valid.')
  })
})
