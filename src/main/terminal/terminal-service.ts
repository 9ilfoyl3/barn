import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { scrubbedShellEnvironment } from '../sandbox/environment'
import { seatbeltProfile } from '../sandbox/macos-seatbelt'
import { resolveSandboxPolicy } from '../sandbox/policy'

export interface TerminalSessionInfo {
  terminalId: string
  shell: string
  cwd: string
}

export interface TerminalDataEvent {
  terminalId: string
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number
  signal?: number | undefined
}

interface TerminalSession {
  pty: IPty
  cwd: string
  shell: string
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly dataListeners = new Set<(event: TerminalDataEvent) => void>()
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>()

  constructor(
    private readonly outputRoot: string,
    private readonly privateTempRoot: string,
  ) {}

  async create(input: {
    terminalId: string
    workingDirectory?: string | undefined
    cols: number
    rows: number
  }): Promise<TerminalSessionInfo> {
    const existing = this.sessions.get(input.terminalId)
    if (existing !== undefined) {
      return { terminalId: input.terminalId, shell: existing.shell, cwd: existing.cwd }
    }
    if (this.sessions.size >= 8) throw new Error('Too many active terminals')
    if (process.platform !== 'darwin') {
      throw new Error('Interactive terminal is currently available on macOS only')
    }

    const cwd = await realpath(input.workingDirectory ?? process.cwd())
    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: cwd,
      outputRoot: this.outputRoot,
      privateTempRoot: this.privateTempRoot,
    })
    const shell = '/bin/zsh'
    const zdotdir = join(this.privateTempRoot, 'terminal-home', input.terminalId)
    await mkdir(zdotdir, { recursive: true, mode: 0o700 })
    await writeFile(join(zdotdir, '.zshrc'), zshrc(), { mode: 0o600 })
    const environment = scrubbedShellEnvironment(process.env, this.privateTempRoot)
    environment.TERM = 'xterm-256color'
    environment.COLORTERM = 'truecolor'
    environment.HOME = process.env.HOME ?? ''
    environment.USER = process.env.USER ?? ''
    environment.LOGNAME = process.env.LOGNAME ?? process.env.USER ?? ''
    environment.SHELL = shell
    environment.PWD = cwd
    environment.ZDOTDIR = zdotdir

    const terminal = spawn('/usr/bin/sandbox-exec', [
      '-p',
      seatbeltProfile({ command: '', cwd, policy }),
      shell,
      '-i',
    ], {
      name: 'xterm-256color',
      cols: clampDimension(input.cols, 20, 240),
      rows: clampDimension(input.rows, 5, 100),
      cwd,
      env: environment,
    })
    this.sessions.set(input.terminalId, { pty: terminal, cwd, shell })
    terminal.onData((data) => {
      for (const listener of this.dataListeners) listener({ terminalId: input.terminalId, data })
    })
    terminal.onExit(({ exitCode, signal }) => {
      this.sessions.delete(input.terminalId)
      for (const listener of this.exitListeners) listener({ terminalId: input.terminalId, exitCode, signal })
    })
    return { terminalId: input.terminalId, shell, cwd }
  }

  write(terminalId: string, data: string): void {
    this.requireSession(terminalId).pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.requireSession(terminalId).pty.resize(
      clampDimension(cols, 20, 240),
      clampDimension(rows, 5, 100),
    )
  }

  dispose(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (session === undefined) return
    this.sessions.delete(terminalId)
    try {
      session.pty.kill()
    } catch {
      // The shell may already have exited.
    }
  }

  disposeAll(): void {
    for (const terminalId of this.sessions.keys()) this.dispose(terminalId)
  }

  onData(listener: (event: TerminalDataEvent) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private requireSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId)
    if (session === undefined) throw new Error(`Unknown terminal: ${terminalId}`)
    return session
  }
}

function clampDimension(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}


function zshrc(): string {
  return `autoload -Uz compinit
compinit -d "$ZDOTDIR/.zcompdump"
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
HISTFILE="$ZDOTDIR/.zsh_history"
HISTSIZE=2000
SAVEHIST=2000
setopt HIST_IGNORE_DUPS
setopt NO_BEEP
unsetopt BEEP
bindkey -e
bindkey '^I' expand-or-complete
autoload -U colors && colors
PROMPT='%F{green}→%f %F{blue}barn%f '
RPROMPT=''
`
}
