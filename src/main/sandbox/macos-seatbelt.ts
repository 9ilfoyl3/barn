import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ShellCapability, ShellRequest, ShellResult } from './types'
import { scrubbedShellEnvironment } from './environment'

const sandboxExec = '/usr/bin/sandbox-exec'

export function macosShellCapability(): ShellCapability {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      backend: 'none',
      reason: 'This platform sandbox backend is not implemented.',
    }
  }
  if (!existsSync(sandboxExec)) {
    return {
      available: false,
      backend: 'seatbelt',
      reason: 'macOS sandbox-exec is unavailable.',
    }
  }
  return {
    available: true,
    backend: 'macos-seatbelt',
  }
}

export function seatbeltProfile(request: ShellRequest): string {
  const allowWrites = request.policy.writeRoots
    .map((root) => `  (subpath ${JSON.stringify(root)})`)
    .join('\n')
  const denyPaths = request.policy.denyPaths
    .map((path) => `  (subpath ${JSON.stringify(path)})`)
    .join('\n')

  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write*
  (literal "/dev/null")
${allowWrites}
)
(deny file-read* file-write*
${denyPaths}
)`
}

export async function runMacosSeatbelt(request: ShellRequest): Promise<ShellResult> {
  const capability = macosShellCapability()
  if (!capability.available) throw new Error(capability.reason ?? 'Sandbox unavailable')

  const environment = scrubbedShellEnvironment(process.env, request.policy.privateTempRoot)
  const args = [
    '-p',
    seatbeltProfile(request),
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-c',
    request.command,
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(sandboxExec, args, {
      cwd: request.cwd,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= request.policy.maxOutputBytes) return current
      return (current + chunk.toString('utf8')).slice(0, request.policy.maxOutputBytes)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })

    const killTree = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, request.policy.timeoutMs)

    const abort = (): void => {
      aborted = true
      killTree()
    }
    request.signal?.addEventListener('abort', abort, { once: true })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
      reject(error)
    })

    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
      resolve({
        command: request.command,
        cwd: request.cwd,
        exitCode,
        stdout,
        stderr,
        timedOut,
        aborted,
        sandbox: {
          backend: 'macos-seatbelt',
          mode: request.policy.mode,
        },
      })
    })
  })
}
