import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { x as extractTar } from 'tar'
import type { DingTalkRuntimeStatus } from '../../shared/models'

const RUNTIME_VERSION = 'v1.0.69'
const RELEASE_BASE = `https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/${RUNTIME_VERSION}`
const DOWNLOAD_TIMEOUT_MS = 180_000
const LOGIN_TIMEOUT_MS = 300_000
const COMMAND_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024
const EXIT_DRAIN_GRACE_MS = 500

interface RuntimeAsset {
  archive: string
  sha256: string
}

const RUNTIME_ASSETS: Readonly<Record<string, RuntimeAsset>> = {
  'darwin-arm64': { archive: 'dws-darwin-arm64.tar.gz', sha256: 'b7dbea8653bcdaa78934f7e632ed8cb7835ba1647b58ddc9b09c6981fc5560d8' },
  'darwin-x64': { archive: 'dws-darwin-amd64.tar.gz', sha256: '4ab7511b7481531195a0d2d6cb16df9546e9513f3d375a165fd1afc892b0e559' },
  'linux-arm64': { archive: 'dws-linux-arm64.tar.gz', sha256: '4a8fdb369527abbb4bcf90ebf79c5e329a2021c2608491f71a610ef3a67a9797' },
  'linux-x64': { archive: 'dws-linux-amd64.tar.gz', sha256: '567257be28c1ccce4f424fc92969f9c21dd15ed600a86c252adbc35821bf7c4a' },
  'win32-arm64': { archive: 'dws-windows-arm64.zip', sha256: '770372e261b2892e148fa7e8ecf129f20bda760016ca5b03facef03ba83d7ae3' },
  'win32-x64': { archive: 'dws-windows-amd64.zip', sha256: '9684b525e836943f41ea6ca03404b2221a25c6ebe63f569487bd06b732574b48' },
}

export interface DingTalkProcessResult {
  code: number
  stdout: string
  stderr: string
}

export interface DingTalkProcessRunner {
  run(file: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<DingTalkProcessResult>
}

export interface DingTalkRuntimeOptions {
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  fetch?: typeof fetch
  processRunner?: DingTalkProcessRunner
}

export interface DingTalkRuntimeClient {
  status(): Promise<DingTalkRuntimeStatus>
  runJson(args: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>>
}

interface ParsedRuntimeIdentity {
  organization?: string
  userName?: string
}

export class DingTalkRuntime implements DingTalkRuntimeClient {
  private readonly platform: NodeJS.Platform
  private readonly arch: NodeJS.Architecture
  private readonly fetchImpl: typeof fetch
  private readonly processRunner: DingTalkProcessRunner
  private readonly runtimeDir: string
  private readonly configDir: string
  private readonly binary: string

  constructor(rootDir: string, options: DingTalkRuntimeOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetchImpl = options.fetch ?? fetch
    this.processRunner = options.processRunner ?? nativeProcessRunner
    this.runtimeDir = join(rootDir, 'dingtalk-runtime', RUNTIME_VERSION)
    this.configDir = join(rootDir, 'dingtalk-runtime', 'state')
    this.binary = join(this.runtimeDir, this.platform === 'win32' ? 'dws.exe' : 'dws')
  }

  async status(): Promise<DingTalkRuntimeStatus> {
    if (!(await exists(this.binary))) return { installed: false, authenticated: false }
    const version = RUNTIME_VERSION.replace(/^v/u, '')
    try {
      const auth = await this.executeJson(['auth', 'status', '--readonly', '--format', 'json'], 20_000)
      const authenticated = auth.authenticated === true
      let identity: ParsedRuntimeIdentity = {}
      if (authenticated) {
        try {
          identity = readIdentity(await this.executeJson(['profile', 'list', '--format', 'json'], 20_000))
        } catch {
          // Authentication is still usable when profile metadata cannot be read.
        }
      }
      return {
        installed: true,
        authenticated,
        version,
        ...identity,
      }
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        version,
        message: safeRuntimeMessage(error),
      }
    }
  }

  async install(): Promise<DingTalkRuntimeStatus> {
    if (await exists(this.binary)) return this.status()
    const asset = resolveRuntimeAsset(this.platform, this.arch)
    if (asset === undefined) throw new Error('DingTalk support is not available for this device')

    const installRoot = join(this.runtimeDir, '..')
    const staging = join(installRoot, `${RUNTIME_VERSION}.install-${process.pid}-${Date.now()}`)
    const archivePath = join(staging, asset.archive)
    const binaryName = this.platform === 'win32' ? 'dws.exe' : 'dws'
    const stagingBinary = join(staging, binaryName)
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 })
      const response = await this.fetchImpl(`${RELEASE_BASE}/${asset.archive}`, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { 'User-Agent': 'barn-desktop' },
      })
      if (!response.ok) throw new Error('Unable to download DingTalk support')
      const archive = Buffer.from(await response.arrayBuffer())
      const digest = createHash('sha256').update(archive).digest('hex')
      if (digest !== asset.sha256) throw new Error('DingTalk support failed integrity verification')
      await writeFile(archivePath, archive, { mode: 0o600 })
      if (asset.archive.endsWith('.zip')) await extractWindowsBinary(archivePath, stagingBinary)
      else await extractUnixBinary(archivePath, stagingBinary)
      if (this.platform !== 'win32') await chmod(stagingBinary, 0o755)
      const result = await this.processRunner.run(stagingBinary, ['--version'], {
        env: this.commandEnv(),
        timeoutMs: 20_000,
      })
      if (result.code !== 0) throw new Error('DingTalk support could not be started')
      await rm(archivePath, { force: true })
      await rm(this.runtimeDir, { recursive: true, force: true })
      await rename(staging, this.runtimeDir)
      return this.status()
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(safeRuntimeMessage(error), { cause: error })
    }
  }

  async login(): Promise<DingTalkRuntimeStatus> {
    if (!(await exists(this.binary))) throw new Error('Install DingTalk support first')
    const result = await this.processRunner.run(this.binary, ['auth', 'login'], {
      env: this.commandEnv(),
      timeoutMs: LOGIN_TIMEOUT_MS,
    })
    if (result.code !== 0) throw new Error(safeRuntimeMessage(result.stderr || result.stdout))
    const status = await this.status()
    if (!status.authenticated) throw new Error('DingTalk sign-in did not complete')
    return status
  }

  async logout(): Promise<void> {
    if (!(await exists(this.binary))) return
    const result = await this.processRunner.run(this.binary, ['auth', 'logout', '--yes', '--format', 'json'], {
      env: this.commandEnv(),
      timeoutMs: 60_000,
    })
    if (result.code !== 0) throw new Error(safeRuntimeMessage(result.stderr || result.stdout))
  }

  async runJson(args: readonly string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const status = await this.status()
    if (!status.authenticated) throw new Error('Sign in to DingTalk first')
    return this.executeJson(args, timeoutMs, signal)
  }

  private async executeJson(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await this.processRunner.run(this.binary, args, {
      env: this.commandEnv(),
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    if (result.code !== 0) throw new Error(safeRuntimeMessage(result.stderr || result.stdout))
    return parseJsonObject(result.stdout)
  }

  private commandEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('DWS_')) continue
      env[key] = value
    }
    env.DWS_CONFIG_DIR = this.configDir
    env.DWS_NO_SKILLS = '1'
    env.NO_COLOR = '1'
    return env
  }
}

export function resolveRuntimeAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): RuntimeAsset | undefined {
  return RUNTIME_ASSETS[`${platform}-${arch}`]
}

export const nativeProcessRunner: DingTalkProcessRunner = {
  run(file, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...args], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      let exited = false
      let exitCode: number | null = null
      let timer: NodeJS.Timeout
      let drainTimer: NodeJS.Timeout | undefined
      const destroyPipes = (): void => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (drainTimer !== undefined) clearTimeout(drainTimer)
        options.signal?.removeEventListener('abort', abort)
        callback()
      }
      const resolveResult = (code: number): void => {
        destroyPipes()
        finish(() => resolve({ code, stdout, stderr }))
      }
      const resolveAfterExit = (): void => {
        if (!exited || settled) return
        resolveResult(exitCode ?? 1)
      }
      const waitForPipeDrain = (): void => {
        if (child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) {
          resolveAfterExit()
          return
        }
        // A successful CLI may leave a grandchild or telemetry handle holding
        // stdout/stderr. `close` then waits forever even though the command has
        // already exited and its bounded output is complete.
        drainTimer = setTimeout(resolveAfterExit, EXIT_DRAIN_GRACE_MS)
        drainTimer.unref?.()
      }
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString('utf8')
        if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
          child.kill()
          throw new Error('DingTalk returned too much data')
        }
        return next
      }
      timer = setTimeout(() => {
        child.kill()
        finish(() => reject(new Error('DingTalk operation timed out')))
      }, options.timeoutMs)
      const abort = (): void => {
        child.kill()
        finish(() => reject(new Error('DingTalk operation was cancelled')))
      }
      if (options.signal?.aborted === true) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          stdout = append(stdout, chunk)
        } catch (error) {
          finish(() => reject(error))
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        try {
          stderr = append(stderr, chunk)
        } catch (error) {
          finish(() => reject(error))
        }
      })
      child.stdout?.on('end', () => {
        if (exited) waitForPipeDrain()
      })
      child.stderr?.on('end', () => {
        if (exited) waitForPipeDrain()
      })
      child.on('error', (error) => finish(() => reject(error)))
      child.on('exit', (code) => {
        exited = true
        exitCode = code ?? 1
        waitForPipeDrain()
      })
      child.on('close', (code) => resolveResult(code ?? exitCode ?? 1))
    })
  },
}

async function extractUnixBinary(archivePath: string, binary: string): Promise<void> {
  const targetDir = join(binary, '..')
  const binaryName = binary.split(/[\\/]/u).at(-1) ?? 'dws'
  await extractTar({
    file: archivePath,
    cwd: targetDir,
    strict: true,
    filter: (path) => path.replace(/^\.\//u, '') === binaryName,
  })
}

async function extractWindowsBinary(archivePath: string, binary: string): Promise<void> {
  const files = unzipSync(new Uint8Array(await readFile(archivePath)))
  const entry = Object.entries(files).find(([name]) => /(^|\/)dws\.exe$/iu.test(name))
  if (entry === undefined) throw new Error('DingTalk support package is incomplete')
  await mkdir(join(binary, '..'), { recursive: true })
  await writeFile(binary, entry[1], { mode: 0o700 })
}

function readIdentity(payload: Record<string, unknown>): ParsedRuntimeIdentity {
  const profiles = Array.isArray(payload.profiles)
    ? payload.profiles.filter((profile): profile is Record<string, unknown> => isRecord(profile))
    : []
  const profile = profiles.find((entry) => entry.isOrgCurrent === true) ?? profiles[0]
  if (profile === undefined) return {}
  const organization = firstString(profile.corpName, profile.orgName, profile.organizationName)
  const userName = firstString(profile.userName, profile.name, profile.nick)
  return {
    ...(organization === undefined ? {} : { organization }),
    ...(userName === undefined ? {} : { userName }),
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isRecord(parsed)) return parsed
  } catch {
    // Commands may print a short version notice before their JSON body.
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1))
    if (isRecord(parsed)) return parsed
  }
  throw new Error('DingTalk returned an invalid response')
}

function safeRuntimeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stripped = message.replace(/\bdws\b/giu, 'DingTalk').replace(/\s+/gu, ' ').trim()
  return stripped.length === 0 ? 'DingTalk operation failed' : stripped.slice(0, 500)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
