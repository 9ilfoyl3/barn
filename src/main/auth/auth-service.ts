import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import type { AuthState, AuthUser } from '../../shared/models'

export interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface AuthServiceOptions {
  userDataDirectory: string
  baseUrl: string
  clientId: string
  codec: SecretCodec
  openExternal(url: string): Promise<void>
  onLogout?: (() => Promise<void>) | undefined
}

interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenType: 'Bearer'
  user: AuthUser
}

export class AuthService {
  private readonly statePath: string
  private readonly devicePath: string
  private accessToken: string | undefined
  private accessTokenExpiresAt = 0
  private refreshToken: string | undefined
  private user: AuthUser | undefined
  private deviceId: string | undefined
  private state: AuthState = { status: 'loading' }
  private readonly listeners = new Set<(state: AuthState) => void>()
  private refreshPromise: Promise<string> | undefined

  constructor(private readonly options: AuthServiceOptions) {
    this.statePath = join(options.userDataDirectory, 'auth', 'session.bin')
    this.devicePath = join(options.userDataDirectory, 'auth', 'device.bin')
  }

  async initialize(): Promise<void> {
    try {
      this.deviceId = await this.loadOrCreateDeviceId()
      this.refreshToken = await this.loadRefreshToken()
      if (this.refreshToken !== undefined) {
        await this.refresh()
        return
      }
      this.setState({ status: 'unauthenticated' })
    } catch (error) {
      this.clearSessionMemory()
      this.setState({ status: 'unauthenticated', error: errorMessage(error) })
    }
  }

  getState(): AuthState {
    return this.state
  }

  onStateChanged(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async login(): Promise<AuthState> {
    if (this.deviceId === undefined) this.deviceId = await this.loadOrCreateDeviceId()
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(24).toString('base64url')
    const callback = await createCallbackServer(state)
    try {
      const authorizeUrl = new URL(`${this.options.baseUrl}/v1/auth/authorize`)
      authorizeUrl.searchParams.set('client_id', this.options.clientId)
      authorizeUrl.searchParams.set('redirect_uri', callback.redirectUri)
      authorizeUrl.searchParams.set('code_challenge', challenge)
      authorizeUrl.searchParams.set('device_id', this.deviceId)
      authorizeUrl.searchParams.set('state', state)
      await this.options.openExternal(authorizeUrl.toString())
      const code = await callback.waitForCode()
      const tokens = await this.request<TokenResponse>('/v1/auth/token', {
        method: 'POST',
        body: JSON.stringify({
          code,
          codeVerifier: verifier,
          clientId: this.options.clientId,
          redirectUri: callback.redirectUri,
          deviceId: this.deviceId,
        }),
      })
      await this.acceptTokens(tokens)
      return this.state
    } catch (error) {
      this.setState({ status: 'unauthenticated', error: errorMessage(error) })
      throw error
    } finally {
      await callback.close()
    }
  }

  async logout(): Promise<AuthState> {
    const refreshToken = this.refreshToken
    this.clearSessionMemory()
    await rm(this.statePath, { force: true }).catch(() => undefined)
    await this.options.onLogout?.().catch(() => undefined)
    this.setState({ status: 'unauthenticated' })
    if (refreshToken !== undefined) {
      await this.request('/v1/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      }).catch(() => undefined)
    }
    return this.state
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken !== undefined && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken
    }
    return this.refresh()
  }

  private async refresh(): Promise<string> {
    this.refreshPromise ??= this.doRefresh().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async doRefresh(): Promise<string> {
    if (this.refreshToken === undefined || this.deviceId === undefined) {
      throw new Error('Sign in to Barn Cloud to access HR data')
    }
    const tokens = await this.request<TokenResponse>('/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        refreshToken: this.refreshToken,
        deviceId: this.deviceId,
      }),
    })
    await this.acceptTokens(tokens)
    return tokens.accessToken
  }

  private async acceptTokens(tokens: TokenResponse): Promise<void> {
    this.accessToken = tokens.accessToken
    this.refreshToken = tokens.refreshToken
    this.accessTokenExpiresAt = Date.now() + tokens.expiresIn * 1_000
    this.user = tokens.user
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const encrypted = this.options.codec.encrypt(JSON.stringify({
      refreshToken: tokens.refreshToken,
    }))
    const temp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, encrypted, { mode: 0o600 })
    await rename(temp, this.statePath)
    this.setState({ status: 'authenticated', user: tokens.user })
  }

  private clearSessionMemory(): void {
    this.accessToken = undefined
    this.refreshToken = undefined
    this.accessTokenExpiresAt = 0
    this.user = undefined
  }

  private async loadRefreshToken(): Promise<string | undefined> {
    try {
      const encrypted = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(this.options.codec.decrypt(encrypted)) as { refreshToken?: unknown }
      return typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  private async loadOrCreateDeviceId(): Promise<string> {
    try {
      return this.options.codec.decrypt(await readFile(this.devicePath, 'utf8'))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    const deviceId = randomBytes(24).toString('base64url')
    await mkdir(dirname(this.devicePath), { recursive: true, mode: 0o700 })
    await writeFile(this.devicePath, this.options.codec.encrypt(deviceId), { mode: 0o600 })
    return deviceId
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Barn Auth ${response.status}: ${body.slice(0, 500)}`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private setState(state: AuthState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}

async function createCallbackServer(expectedState: string): Promise<{
  redirectUri: string
  waitForCode(): Promise<string>
  close(): Promise<void>
}> {
  let resolveCode: ((code: string) => void) | undefined
  let rejectCode: ((error: Error) => void) | undefined
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server: Server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (error !== null || state !== expectedState || code === null) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Barn sign in failed. You can close this window.')
        rejectCode?.(new Error(error ?? 'Invalid authorization callback'))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Barn</title><body style="background:#111311;color:#e8e6dc;font:16px sans-serif;padding:40px"><h1>Signed in to Barn</h1><p>You can close this window and return to the app.</p></body>')
      resolveCode?.(code)
    } catch (error) {
      rejectCode?.(error instanceof Error ? error : new Error(String(error)))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Unable to bind auth callback')
  const timeout = setTimeout(() => rejectCode?.(new Error('Sign in timed out')), 5 * 60_000)
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: () => codePromise,
    close: async () => {
      clearTimeout(timeout)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
