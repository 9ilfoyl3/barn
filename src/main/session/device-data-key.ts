import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export async function loadOrCreateDeviceDataKey(path: string): Promise<Buffer> {
  try {
    const wrapped = await readFile(path, 'utf8')
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential encryption is unavailable')
    }
    return Buffer.from(safeStorage.decryptString(Buffer.from(wrapped, 'base64')), 'base64')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable')
  }
  const key = randomBytes(32)
  const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, wrapped, { mode: 0o600 })
  await rename(temp, path)
  return key
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}
