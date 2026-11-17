import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EncryptedCredentialStore,
  type SecretCodec,
} from '../src/main/models/credential-store'

class TestCodec implements SecretCodec {
  async encrypt(value: string): Promise<string> {
    return Buffer.from(value).toString('base64')
  }

  async decrypt(value: string): Promise<string> {
    return Buffer.from(value, 'base64').toString('utf8')
  }
}

describe('EncryptedCredentialStore', () => {
  it('saves, lists, updates, and deletes provider credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-credentials-'))
    const path = join(directory, 'credentials.bin')
    const store = new EncryptedCredentialStore(path, new TestCodec())

    await store.modify('openai', async () => ({ type: 'api_key', key: 'first' }))
    expect(await store.list()).toEqual([{ providerId: 'openai', type: 'api_key' }])
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'first' })
    expect(await readFile(path, 'utf8')).not.toContain('first')

    await store.modify('openai', async () => ({ type: 'api_key', key: 'second' }))
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'second' })

    await store.delete('openai')
    expect(await store.read('openai')).toBeUndefined()
  })
})
