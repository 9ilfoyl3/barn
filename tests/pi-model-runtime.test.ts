import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EncryptedCredentialStore } from '../src/main/models/credential-store'
import { PiModelRuntime } from '../src/main/models/pi-model-runtime'

const identityCodec = {
  encrypt(value: string) { return value },
  decrypt(value: string) { return value },
}

describe('PiModelRuntime', () => {
  it('registers the full built-in pi-ai provider catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-models-'))
    const credentials = new EncryptedCredentialStore(join(directory, 'credentials'), identityCodec)
    const runtime = new PiModelRuntime(credentials)
    const providers = runtime.getProviders()
    expect(providers.length).toBeGreaterThan(20)
    expect(providers.some((provider) => provider.id === 'openai')).toBe(true)
    expect(providers.some((provider) => provider.id === 'anthropic')).toBe(true)
    expect(providers.some((provider) => provider.id === 'deepseek')).toBe(true)
  })

  it('adds a custom provider from local settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-models-'))
    const credentials = new EncryptedCredentialStore(join(directory, 'credentials'), identityCodec)
    const runtime = new PiModelRuntime(credentials)
    runtime.replaceCustomProviders([{
      id: 'acme',
      name: 'Acme Gateway',
      baseUrl: 'https://gateway.example/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'acme-chat',
          name: 'Acme Chat',
          contextWindow: 128_000,
          maxTokens: 32_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        },
        {
          id: 'acme-reasoner',
          name: 'Acme Reasoner',
          contextWindow: 128_000,
          maxTokens: 32_000,
          reasoning: true,
          reasoningEfforts: ['low', 'high', 'max'],
          input: ['text'],
        },
      ],
    }])

    expect(runtime.getProviders().some((provider) => provider.id === 'acme')).toBe(true)
    expect(runtime.getModels('acme')).toEqual([
      expect.objectContaining({
        id: 'acme-chat',
        providerId: 'acme',
        reasoningEfforts: [],
      }),
      expect.objectContaining({
        id: 'acme-reasoner',
        providerId: 'acme',
        reasoningEfforts: ['low', 'high', 'max'],
      }),
    ])
    expect(runtime.getModel({ providerId: 'acme', modelId: 'acme-reasoner' })?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    })
  })
})
