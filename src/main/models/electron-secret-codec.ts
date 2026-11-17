import { safeStorage } from 'electron'
import type { SecretCodec } from './credential-store'

export class ElectronSecretCodec implements SecretCodec {
  async encrypt(value: string): Promise<string> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('OS credential encryption is unavailable')
    }
    return (await safeStorage.encryptStringAsync(value)).toString('base64')
  }

  async decrypt(value: string): Promise<string> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('OS credential encryption is unavailable')
    }
    const encrypted = Buffer.from(value, 'base64')
    let decrypted = await safeStorage.decryptStringAsync(encrypted)
    if (decrypted.shouldReEncrypt) decrypted = await safeStorage.decryptStringAsync(encrypted)
    return decrypted.result
  }
}
