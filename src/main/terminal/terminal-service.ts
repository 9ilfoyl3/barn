import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ShellService } from '../sandbox/shell-service'
import { resolveSandboxPolicy } from '../sandbox/policy'

export interface TerminalRunInput {
  terminalId: string
  command: string
  workingDirectory?: string | undefined
}

export interface TerminalRunResult {
  cwd: string
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export class TerminalService {
  private readonly cwds = new Map<string, string>()

  constructor(
    private readonly shell: ShellService,
    private readonly workspaceRoot: string,
    private readonly outputRoot: string,
    private readonly privateTempRoot: string,
  ) {}

  async run(input: TerminalRunInput): Promise<TerminalRunResult> {
    const sandboxRoot = await realpath(input.workingDirectory ?? this.workspaceRoot)
    const cwd = this.cwds.get(input.terminalId) ?? sandboxRoot
    const trimmed = input.command.trim()

    if (trimmed === 'clear') {
      return { cwd, command: input.command, stdout: '', stderr: '', exitCode: 0, timedOut: false }
    }
    if (trimmed.startsWith('cd ')) {
      const destination = trimmed.slice(3).trim() || sandboxRoot
      const candidate = isAbsolute(destination) ? destination : resolve(cwd, destination)
      const canonical = await realpath(candidate)
      if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${destination}`)
      this.assertAllowed(canonical, sandboxRoot)
      this.cwds.set(input.terminalId, canonical)
      return { cwd: canonical, command: input.command, stdout: '', stderr: '', exitCode: 0, timedOut: false }
    }

    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: sandboxRoot,
      outputRoot: this.outputRoot,
      privateTempRoot: this.privateTempRoot,
    })
    const result = await this.shell.run({ command: input.command, cwd, policy })
    return {
      cwd,
      command: input.command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }
  }

  private assertAllowed(path: string, sandboxRoot: string): void {
    const roots = [sandboxRoot, this.outputRoot, this.privateTempRoot]
    const allowed = roots.some((root) => {
      const rel = relative(root, path)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    })
    if (!allowed) throw new Error('Terminal path is outside the authorized workspace')
  }
}
