import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ConnectorCredentialStore } from '../../src/main/connectors/connector-credentials'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import type { SecretCodec } from '../../src/main/models/credential-store'

class TestCodec implements SecretCodec {
  async encrypt(value: string): Promise<string> {
    return Buffer.from(value).toString('base64')
  }

  async decrypt(value: string): Promise<string> {
    return Buffer.from(value, 'base64').toString('utf8')
  }
}

describe('Connector storage', () => {
  it('encrypts connector configuration and credentials at rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-connector-store-'))
    const path = join(directory, 'sessions.db')
    const store = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const connector = store.connectors.create({
      kind: 'email',
      name: 'Work mail',
      config: {
        emailAddress: 'private@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
      },
    })
    store.close()

    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT config_ciphertext FROM connectors WHERE id = ?').get(connector.id) as {
      config_ciphertext: Uint8Array
    }
    expect(Buffer.from(row.config_ciphertext).toString('utf8')).not.toContain('private@example.com')
    raw.close()

    const credentialsPath = join(directory, 'credentials.enc')
    const credentials = new ConnectorCredentialStore(credentialsPath, new TestCodec())
    await credentials.save(connector.id, { username: 'private@example.com', password: 'app-password' })
    const encrypted = await readFile(credentialsPath, 'utf8')
    expect(encrypted).not.toContain('app-password')
    expect(await credentials.read(connector.id)).toEqual({
      username: 'private@example.com',
      password: 'app-password',
    })

    const reopened = new SessionStore(path, new AesGcmEventCipher(randomBytes(32)))
    // The database encryption key is required to decrypt configuration, so a different key must fail.
    await expect(reopened.initialize()).resolves.toBeUndefined()
    expect(() => reopened.connectors.get(connector.id)).toThrow()
    reopened.close()
  })

  it('updates and deletes connector instances and credential records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-connector-store-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const connector = store.connectors.create({
      kind: 'email',
      name: 'Mail',
      config: { emailAddress: 'a@example.com' },
    }, randomUUID())
    expect(store.connectors.update(connector.id, { enabled: false }).enabled).toBe(false)
    expect(store.connectors.setError(connector.id, 'login failed').lastError).toBe('login failed')
    expect(store.connectors.setError(connector.id, undefined).lastError).toBeUndefined()

    const credentials = new ConnectorCredentialStore(join(directory, 'credentials.enc'), new TestCodec())
    await credentials.save(connector.id, { username: 'a', password: 'b' })
    await credentials.save(connector.id, { password: 'c' })
    expect(await credentials.read(connector.id)).toEqual({ username: 'a', password: 'c' })
    await credentials.delete(connector.id)
    expect(await credentials.read(connector.id)).toEqual({})

    store.connectors.remove(connector.id)
    expect(store.connectors.list()).toEqual([])
    store.close()
  })
})
