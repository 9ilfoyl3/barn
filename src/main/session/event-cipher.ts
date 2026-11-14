import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export interface EncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
  tag: Uint8Array
}

export class AesGcmEventCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Session encryption key must be 32 bytes')
  }

  encrypt(value: unknown, associatedData: string): EncryptedPayload {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(associatedData, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ])
    return {
      ciphertext,
      nonce,
      tag: cipher.getAuthTag(),
    }
  }

  fingerprint(value: string): string {
    return createHmac('sha256', this.key).update(value, 'utf8').digest('hex')
  }

  decrypt<T>(payload: EncryptedPayload, associatedData: string): T {
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.nonce)
    decipher.setAAD(Buffer.from(associatedData, 'utf8'))
    decipher.setAuthTag(payload.tag)
    const plaintext = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as T
  }
}
