import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'

export interface SecretCodec {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

interface CredentialFile {
  version: 1
  credentials: Record<string, Credential>
}

export class EncryptedCredentialStore implements CredentialStore {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId]
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.withLock(providerId, async () => {
      const credentials = await this.readAll()
      const current = credentials[providerId]
      const next = await fn(current)
      if (next === undefined) return current
      credentials[providerId] = next
      await this.writeAll(credentials)
      return next
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(providerId, async () => {
      const credentials = await this.readAll()
      if (!(providerId in credentials)) return
      delete credentials[providerId]
      await this.writeAll(credentials)
    })
  }

  private async readAll(): Promise<Record<string, Credential>> {
    let encrypted: string
    try {
      encrypted = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return {}
      throw error
    }

    const parsed = JSON.parse(await this.codec.decrypt(encrypted)) as Partial<CredentialFile>
    if (parsed.version !== 1 || typeof parsed.credentials !== 'object' || parsed.credentials === null) {
      throw new Error('Invalid Barn credential file')
    }
    return parsed.credentials
  }

  private async writeAll(credentials: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const body: CredentialFile = { version: 1, credentials }
    const encrypted = await this.codec.encrypt(JSON.stringify(body))
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, encrypted, { mode: 0o600 })
    await rename(temp, this.path)
  }

  private async withLock<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(providerId) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.locks.set(providerId, current)
    try {
      return await current
    } finally {
      if (this.locks.get(providerId) === current) this.locks.delete(providerId)
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}
