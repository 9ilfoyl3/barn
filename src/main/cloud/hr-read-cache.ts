import { rm, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HrReadMetadata } from '../../shared/models'
import { AesGcmEventCipher } from '../session/event-cipher'

export interface HrReadCacheScope {
  userId: string
  tenantId: string
}

export interface CachedHrRead<T> {
  data: T
  metadata: Omit<HrReadMetadata, 'source'>
}

interface CacheEntry {
  storedAt: number
  expiresAt: number
  data: unknown
}

interface CacheFile {
  version: 1
  userId: string
  tenantId: string
  entries: Record<string, CacheEntry>
}

interface EncryptedCacheFile {
  version: 1
  ciphertext: string
  nonce: string
  tag: string
}

export interface HrReadCacheOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

export class HrReadCache {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private activeScope: HrReadCacheScope | undefined
  private entries: Record<string, CacheEntry> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly cipher: AesGcmEventCipher,
    options: HrReadCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000
    this.maxEntries = options.maxEntries ?? 100
    this.now = options.now ?? Date.now
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('HR cache TTL must be positive')
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) throw new Error('HR cache max entries must be positive')
  }

  async activate(scope: HrReadCacheScope): Promise<void> {
    await this.serial(async () => {
      if (sameScope(this.activeScope, scope)) return
      if (this.activeScope !== undefined) await rm(this.scopeDirectory(this.activeScope), { recursive: true, force: true })
      this.activeScope = { ...scope }
      this.entries = undefined
    })
  }

  async get<T>(scope: HrReadCacheScope, key: string): Promise<CachedHrRead<T> | undefined> {
    return this.serial(async () => {
      if (!sameScope(this.activeScope, scope)) return undefined
      const entries = await this.loadEntries(scope)
      const entry = entries[key]
      if (entry === undefined) return undefined
      if (entry.expiresAt <= this.now()) {
        delete entries[key]
        await this.persist(scope, entries)
        return undefined
      }
      return {
        data: entry.data as T,
        metadata: {
          cachedAt: new Date(entry.storedAt).toISOString(),
          expiresAt: new Date(entry.expiresAt).toISOString(),
        },
      }
    })
  }

  async put<T>(
    scope: HrReadCacheScope,
    key: string,
    data: T,
  ): Promise<Omit<HrReadMetadata, 'source'> | undefined> {
    return this.serial(async () => {
      if (!sameScope(this.activeScope, scope)) return undefined
      const entries = await this.loadEntries(scope)
      const now = this.now()
      for (const [entryKey, entry] of Object.entries(entries)) {
        if (entry.expiresAt <= now) delete entries[entryKey]
      }
      if (Object.keys(entries).length >= this.maxEntries) {
        const oldest = Object.entries(entries).toSorted(([, left], [, right]) => left.storedAt - right.storedAt)[0]
        if (oldest !== undefined) delete entries[oldest[0]]
      }
      entries[key] = {
        storedAt: now,
        expiresAt: now + this.ttlMs,
        data,
      }
      await this.persist(scope, entries)
      return {
        cachedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      }
    })
  }

  async clear(): Promise<void> {
    await this.serial(async () => {
      if (this.activeScope === undefined) return
      await rm(this.scopeDirectory(this.activeScope), { recursive: true, force: true })
      this.activeScope = undefined
      this.entries = undefined
    })
  }

  async clearScope(scope: HrReadCacheScope): Promise<void> {
    await this.serial(async () => {
      await rm(this.scopeDirectory(scope), { recursive: true, force: true })
      if (sameScope(this.activeScope, scope)) {
        this.activeScope = undefined
        this.entries = undefined
      }
    })
  }

  private async loadEntries(scope: HrReadCacheScope): Promise<Record<string, CacheEntry>> {
    if (this.entries !== undefined) return this.entries
    try {
      const serialized = await readFile(this.cachePath(scope), 'utf8')
      const encrypted = JSON.parse(serialized) as EncryptedCacheFile
      const file = this.cipher.decrypt<CacheFile>({
        ciphertext: Buffer.from(encrypted.ciphertext, 'base64'),
        nonce: Buffer.from(encrypted.nonce, 'base64'),
        tag: Buffer.from(encrypted.tag, 'base64'),
      }, associatedData(scope))
      if (file.version !== 1 || file.userId !== scope.userId || file.tenantId !== scope.tenantId) {
        throw new Error('HR cache scope mismatch')
      }
      this.entries = file.entries
    } catch {
      this.entries = {}
    }
    return this.entries
  }

  private async persist(scope: HrReadCacheScope, entries: Record<string, CacheEntry>): Promise<void> {
    const file: CacheFile = {
      version: 1,
      userId: scope.userId,
      tenantId: scope.tenantId,
      entries,
    }
    const encrypted = this.cipher.encrypt(file, associatedData(scope))
    const serialized = JSON.stringify({
      version: 1,
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      tag: Buffer.from(encrypted.tag).toString('base64'),
    } satisfies EncryptedCacheFile)
    const path = this.cachePath(scope)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, serialized, { mode: 0o600 })
    await rename(temp, path)
  }

  private cachePath(scope: HrReadCacheScope): string {
    return join(this.scopeDirectory(scope), 'hr-read-cache.bin')
  }

  private scopeDirectory(scope: HrReadCacheScope): string {
    return join(this.root, safeSegment(scope.userId), 'tenants', safeSegment(scope.tenantId), 'cache')
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function sameScope(left: HrReadCacheScope | undefined, right: HrReadCacheScope): boolean {
  return left?.userId === right.userId && left.tenantId === right.tenantId
}

function safeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function associatedData(scope: HrReadCacheScope): string {
  return `barn-hr-cache:${scope.userId}:${scope.tenantId}`
}
