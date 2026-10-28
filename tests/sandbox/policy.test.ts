import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scrubbedShellEnvironment } from '../../src/main/sandbox/environment'
import { seatbeltProfile } from '../../src/main/sandbox/macos-seatbelt'
import { resolveSandboxPolicy } from '../../src/main/sandbox/policy'

describe('sandbox policy', () => {
  it('allows output writes without granting the workspace', () => {
    const policy = resolveSandboxPolicy({
      mode: 'output-write',
      workspaceRoot: '/work/workspace',
      outputRoot: '/work/output',
      privateTempRoot: '/tmp/barn-private',
    })
    expect(policy.writeRoots).toContain('/work/output')
    expect(policy.writeRoots).not.toContain('/work/workspace')
    expect(policy.denyPaths).toContain(join(homedir(), '.ssh'))
  })

  it('scrubs ambient credentials and redirects temp', () => {
    const environment = scrubbedShellEnvironment({
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'secret',
      AWS_SESSION_TOKEN: 'secret',
      HOME: '/Users/example',
    }, '/tmp/barn-private')
    expect(environment.PATH).toBe('/usr/bin:/bin')
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.AWS_SESSION_TOKEN).toBeUndefined()
    expect(environment.HOME).toBeUndefined()
    expect(environment.TMPDIR).toBe('/tmp/barn-private')
  })

  it('generates a network-denying Seatbelt profile', () => {
    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: '/work/workspace',
      outputRoot: '/work/output',
      privateTempRoot: '/tmp/barn-private',
    })
    const profile = seatbeltProfile({
      command: 'true',
      cwd: '/work/workspace',
      policy,
    })
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(subpath "/work/workspace")')
    expect(profile).toContain('(subpath "/work/output")')
  })
})
