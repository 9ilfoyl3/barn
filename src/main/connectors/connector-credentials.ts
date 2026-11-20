import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SecretCodec } from '../models/credential-store'

interface ConnectorCredentialFile {
  version: 1
  credentials: Record<string, Record<string, string>>
}

/** Connector credentials are kept outside SQLite and encrypted with the OS-backed secret codec. */
export class ConnectorCredentialStore {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec,
  ) {}

  async read(connectorId: string): Promise<Record<string, string>> {
    return { ...(await this.readAll())[connectorId] }
  }

  async keys(connectorId: string): Promise<string[]> {
    return Object.keys((await this.readAll())[connectorId] ?? {}).toSorted()
  }

  async save(connectorId: string, values: Record<string, string>, replace = false): Promise<Record<string, string>> {
    return this.withLock(connectorId, async () => {
      const credentials = await this.readAll()
      const current = credentials[connectorId] ?? {}
      const normalized = Object.fromEntries(
        Object.entries(values)
          .map(([key, value]) => [key.trim(), value] as const)
          .filter(([key, value]) => key.length > 0 && value.length > 0),
      )
      const next = replace ? normalized : { ...current, ...normalized }
      if (Object.keys(next).length === 0) delete credentials[connectorId]
      else credentials[connectorId] = next
      await this.writeAll(credentials)
      return { ...next }
    })
  }

  async delete(connectorId: string): Promise<void> {
    await this.withLock(connectorId, async () => {
      const credentials = await this.readAll()
      if (!(connectorId in credentials)) return
      delete credentials[connectorId]
      await this.writeAll(credentials)
    })
  }

  private async readAll(): Promise<Record<string, Record<string, string>>> {
    let encrypted: string
    try {
      encrypted = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return {}
      throw error
    }
    const parsed = JSON.parse(await this.codec.decrypt(encrypted)) as Partial<ConnectorCredentialFile>
    if (parsed.version !== 1 || typeof parsed.credentials !== 'object' || parsed.credentials === null) {
      throw new Error('Invalid Barn connector credential file')
    }
    return parsed.credentials
  }

  private async writeAll(credentials: Record<string, Record<string, string>>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const body: ConnectorCredentialFile = { version: 1, credentials }
    const encrypted = await this.codec.encrypt(JSON.stringify(body))
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, encrypted, { mode: 0o600 })
    await rename(temp, this.path)
  }

  private async withLock<T>(connectorId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(connectorId) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.locks.set(connectorId, current)
    try {
      return await current
    } finally {
      if (this.locks.get(connectorId) === current) this.locks.delete(connectorId)
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
