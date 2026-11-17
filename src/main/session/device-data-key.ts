import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export async function loadOrCreateDeviceDataKey(path: string): Promise<Buffer> {
  try {
    const wrapped = await readFile(path, 'utf8')
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('OS credential encryption is unavailable')
    }
    const encrypted = Buffer.from(wrapped, 'base64')
    let decrypted = await safeStorage.decryptStringAsync(encrypted)
    if (decrypted.shouldReEncrypt) decrypted = await safeStorage.decryptStringAsync(encrypted)
    return Buffer.from(decrypted.result, 'base64')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('OS credential encryption is unavailable')
  }
  const key = randomBytes(32)
  const wrapped = (await safeStorage.encryptStringAsync(key.toString('base64'))).toString('base64')
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
