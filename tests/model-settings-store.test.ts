import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelSettingsStore } from '../src/main/models/model-settings-store'

describe('ModelSettingsStore', () => {
  it('persists default selection and custom providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-model-settings-'))
    const store = new ModelSettingsStore(directory)

    await store.setDefault({ providerId: 'openai', modelId: 'gpt-test' })
    await store.upsertCustomProvider({
      id: 'acme',
      name: 'Acme',
      baseUrl: 'https://gateway.example/v1',
      api: 'openai-completions',
      models: [{
        id: 'acme-chat',
        name: 'Acme Chat',
        contextWindow: 128_000,
        maxTokens: 32_000,
        reasoning: false,
        input: ['text'],
      }],
    })

    const settings = await store.read()
    expect(settings.defaultModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-test',
    })
    expect(settings.customProviders).toHaveLength(1)
    const raw = await readFile(store.path, 'utf8')
    expect(raw).not.toContain('apiKey')
  })

  it('removes the default when deleting its custom provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-model-settings-'))
    const store = new ModelSettingsStore(directory)
    await store.upsertCustomProvider({
      id: 'acme',
      name: 'Acme',
      baseUrl: 'https://gateway.example/v1',
      api: 'openai-responses',
      models: [{
        id: 'acme-chat',
        name: 'Acme Chat',
        contextWindow: 128_000,
        maxTokens: 32_000,
        reasoning: true,
        input: ['text'],
      }],
    })
    await store.setDefault({ providerId: 'acme', modelId: 'acme-chat' })
    const settings = await store.deleteCustomProvider('acme')
    expect(settings.defaultModel).toBeUndefined()
    expect(settings.customProviders).toEqual([])
  })
})
