import { safeStorage } from 'electron'
import type { SecretCodec } from './credential-store'

export class ElectronSecretCodec implements SecretCodec {
  encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential encryption is unavailable')
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  decrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential encryption is unavailable')
    }
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }
}
