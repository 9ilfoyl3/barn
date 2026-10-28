import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AuthService, type SecretCodec } from '../../src/main/auth/auth-service'

const codec: SecretCodec = {
  encrypt: (value) => value,
  decrypt: (value) => value,
}

const user = {
  id: 'user-1',
  email: 'hrbp@barn.local',
  name: 'Demo HRBP',
  tenantId: 'tenant-1',
  tenantName: 'Demo Tenant',
  deviceId: 'device-1',
  roles: ['hrbp'],
  permissions: ['employee.read'],
}

describe('AuthService', () => {
  it('completes browser PKCE login, restores refresh session and logs out', async () => {
    const server = await startAuthServer()
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Auth server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const directory = await mkdtemp(join(tmpdir(), 'barn-auth-service-'))
    const onLogout = vi.fn(async () => undefined)
    const auth = new AuthService({
      userDataDirectory: directory,
      baseUrl,
      clientId: 'barn-desktop',
      codec,
      openExternal: async (authorizeUrl) => {
        const url = new URL(authorizeUrl)
        const redirectUri = url.searchParams.get('redirect_uri')
        const state = url.searchParams.get('state')
        if (redirectUri === null || state === null) throw new Error('Missing callback request')
        const callback = new URL(redirectUri)
        callback.searchParams.set('code', 'test-code')
        callback.searchParams.set('state', state)
        const response = await fetch(callback)
        expect(response.ok).toBe(true)
      },
    })

    await auth.initialize()
    expect(auth.getState().status).toBe('unauthenticated')
    const loggedIn = await auth.login()
    expect(loggedIn).toMatchObject({
      status: 'authenticated',
      user: { email: 'hrbp@barn.local', tenantId: 'tenant-1' },
    })
    expect(await auth.getAccessToken()).toBe('access-1')

    const restored = new AuthService({
      userDataDirectory: directory,
      baseUrl,
      clientId: 'barn-desktop',
      codec,
      openExternal: async () => undefined,
      onLogout,
    })
    await restored.initialize()
    expect(restored.getState().status).toBe('authenticated')
    expect(await restored.getAccessToken()).toBe('access-refresh-1')

    expect((await restored.logout()).status).toBe('unauthenticated')
    expect(onLogout).toHaveBeenCalledOnce()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

async function startAuthServer(): Promise<Server> {
  let refreshCount = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      if (request.url === '/v1/auth/token') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresIn: 600,
          tokenType: 'Bearer',
          user,
        }))
        return
      }
      if (request.url === '/v1/auth/refresh') {
        refreshCount++
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          accessToken: `access-refresh-${refreshCount}`,
          refreshToken: `refresh-${refreshCount + 1}`,
          expiresIn: 600,
          tokenType: 'Bearer',
          user,
        }))
        return
      }
      if (request.url === '/v1/auth/logout') {
        response.writeHead(204).end()
        return
      }
      response.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}
