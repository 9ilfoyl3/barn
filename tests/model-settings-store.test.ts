import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelSettingsStore } from '../src/main/models/model-settings-store'

describe('ModelSettingsStore', () => {
  it('persists default selection and custom providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-model-settings-'))
    const store = new ModelSettingsStore(directory)

    await store.setDefault({ providerId: 'openai', modelId: 'gpt-test' }, 'high')
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
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        input: ['text'],
      }],
    })

    const settings = await store.read()
    expect(settings.defaultModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-test',
    })
    expect(settings.defaultReasoningEffort).toBe('high')
    expect(settings.customProviders[0]?.models[0]?.reasoningEfforts).toEqual(['low', 'high'])
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
        reasoningEfforts: ['low', 'medium', 'high'],
        input: ['text'],
      }],
    })
    await store.setDefault({ providerId: 'acme', modelId: 'acme-chat' }, 'medium')
    const settings = await store.deleteCustomProvider('acme')
    expect(settings.defaultModel).toBeUndefined()
    expect(settings.defaultReasoningEffort).toBeUndefined()
    expect(settings.customProviders).toEqual([])
  })

  it('migrates reasoning models that predate explicit effort support', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-model-settings-'))
    const store = new ModelSettingsStore(directory)
    await writeFile(store.path, JSON.stringify({
      version: 1,
      customProviders: [{
        id: 'legacy',
        name: 'Legacy',
        baseUrl: 'https://gateway.example/v1',
        api: 'openai-completions',
        models: [{
          id: 'legacy-reasoner',
          name: 'Legacy Reasoner',
          contextWindow: 128_000,
          maxTokens: 32_000,
          reasoning: true,
          input: ['text'],
        }],
      }],
    }))

    const settings = await store.read()
    expect(settings.customProviders[0]?.models[0]?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
    ])
  })
})
