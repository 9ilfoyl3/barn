import { randomBytes } from 'node:crypto'
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HrClient } from '../../src/main/cloud/hr-client'
import { HrReadCache, type HrReadCacheScope } from '../../src/main/cloud/hr-read-cache'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import type { EmployeeSearchResult } from '../../src/shared/models'

const scope: HrReadCacheScope = { userId: 'user-1', tenantId: 'tenant-1' }
const otherScope: HrReadCacheScope = { userId: 'user-1', tenantId: 'tenant-2' }

describe('HrReadCache', () => {
  it('encrypts scoped reads on disk and expires them at the TTL boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'barn-hr-cache-'))
    let now = Date.parse('2026-10-28T10:00:00.000Z')
    const cache = new HrReadCache(root, new AesGcmEventCipher(randomBytes(32)), {
      ttlMs: 60_000,
      now: () => now,
    })
    await cache.activate(scope)
    const metadata = await cache.put(scope, 'employee:employee-1', {
      id: 'employee-1',
      displayName: '张三',
      workEmail: 'zhang@example.com',
      version: 1,
    })
    expect(metadata).toEqual({
      cachedAt: '2026-10-28T10:00:00.000Z',
      expiresAt: '2026-10-28T10:01:00.000Z',
    })
    expect(await cache.get(scope, 'employee:employee-1')).toMatchObject({
      data: { id: 'employee-1', displayName: '张三', version: 1 },
    })

    const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith('.bin'))
    expect(files).toHaveLength(1)
    const encrypted = await readFile(join(root, files[0]!), 'utf8')
    expect(encrypted).not.toContain('张三')
    expect(encrypted).not.toContain('zhang@example.com')

    now += 60_000
    expect(await cache.get(scope, 'employee:employee-1')).toBeUndefined()
  })

  it('removes the previous account and tenant partition when scope changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'barn-hr-cache-'))
    const cache = new HrReadCache(root, new AesGcmEventCipher(randomBytes(32)))
    await cache.activate(scope)
    await cache.put(scope, 'employee:employee-1', { id: 'employee-1', version: 1 })
    const firstFile = (await readdir(root, { recursive: true })).find((path) => path.endsWith('.bin'))
    if (firstFile === undefined) throw new Error('Cache file was not created')

    await cache.activate(otherScope)
    await expect(access(join(root, firstFile))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await cache.get(otherScope, 'employee:employee-1')).toBeUndefined()
  })

  it('replaces a cached employee when the server returns a newer version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'barn-hr-cache-'))
    const cache = new HrReadCache(root, new AesGcmEventCipher(randomBytes(32)))
    await cache.activate(scope)
    await cache.put(scope, 'employee:employee-1', { id: 'employee-1', version: 1, displayName: '旧名字' })
    await cache.put(scope, 'employee:employee-1', { id: 'employee-1', version: 2, displayName: '新名字' })
    expect(await cache.get(scope, 'employee:employee-1')).toMatchObject({
      data: { version: 2, displayName: '新名字' },
    })
  })
})

describe('HrClient encrypted read cache', () => {
  it('reads fresh cache offline but never uses cache for writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'barn-hr-client-cache-'))
    const cache = new HrReadCache(root, new AesGcmEventCipher(randomBytes(32)))
    const searchResult: EmployeeSearchResult = {
      employees: [{ id: 'employee-1', employeeNo: 'E1001', displayName: '张三' }],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
      hasNextPage: false,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(searchResult))
    vi.stubGlobal('fetch', fetchMock)
    const getAccessToken = vi.fn(async () => 'token-1')
    const client = new HrClient(getAccessToken, 'http://hr.test', {
      cache,
      getAuthScope: () => scope,
    })
    try {
      const network = await client.searchEmployees({ q: '张三', page: 1, pageSize: 25 })
      expect(network.cache?.source).toBe('network')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      fetchMock.mockRejectedValue(new Error('offline'))
      const cached = await client.searchEmployees({ pageSize: 25, page: 1, q: '张三' })
      expect(cached).toMatchObject({
        employees: [{ displayName: '张三' }],
        cache: { source: 'cache' },
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(getAccessToken).toHaveBeenCalledTimes(1)

      await expect(client.preview({
        id: 'intake-1',
        sessionId: 'session-1',
        revision: 1,
        status: 'draft',
        employees: [],
        createdAt: '2026-10-28T10:00:00.000Z',
        updatedAt: '2026-10-28T10:00:00.000Z',
      })).rejects.toThrow('offline')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      fetchMock.mockResolvedValueOnce(jsonResponse({ employees: [], committedAt: '2026-10-28T10:00:00.000Z' }))
      const committed = await client.commit({
        previewId: 'preview-1',
        previewHash: 'a'.repeat(64),
        employeeIds: ['employee-1'],
      })
      expect(committed.employees).toEqual([])
      expect(await cache.get(scope, 'employee-search:{"page":1,"pageSize":25,"q":"张三"}')).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
