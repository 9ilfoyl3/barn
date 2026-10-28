import { join } from 'node:path'
import type {
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type {
  CustomProviderConfig,
  ModelConfigSnapshot,
  ModelDescriptor,
  ModelSelection,
  ModelTestResult,
} from '../../shared/models'
import { EncryptedCredentialStore } from './credential-store'
import { ElectronSecretCodec } from './electron-secret-codec'
import { ModelSettingsStore } from './model-settings-store'
import { PiModelRuntime } from './pi-model-runtime'

export class ModelService {
  private readonly settings: ModelSettingsStore
  private readonly runtime: PiModelRuntime
  private readonly credentials: EncryptedCredentialStore

  constructor(userDataDirectory: string) {
    const modelsDirectory = join(userDataDirectory, 'models')
    this.settings = new ModelSettingsStore(modelsDirectory)
    this.credentials = new EncryptedCredentialStore(
      join(modelsDirectory, 'credentials.bin'),
      new ElectronSecretCodec(),
    )
    this.runtime = new PiModelRuntime(this.credentials)
  }

  async initialize(): Promise<void> {
    const current = await this.settings.read()
    this.runtime.replaceCustomProviders(current.customProviders)
  }

  async getSnapshot(): Promise<ModelConfigSnapshot> {
    const settings = await this.settings.read()
    const customIds = new Set(settings.customProviders.map((provider) => provider.id))
    const providers = await Promise.all(this.runtime.getProviders().map(async (provider) => {
      const auth = await this.runtime.checkAuth(provider.id)
      return {
        id: provider.id,
        name: provider.name,
        ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
        kind: customIds.has(provider.id) ? 'custom' as const : 'builtin' as const,
        configured: auth.configured,
        ...(auth.source === undefined ? {} : { authSource: auth.source }),
        modelCount: this.runtime.getModels(provider.id).length,
      }
    }))

    return {
      providers: providers.toSorted((a, b) => a.name.localeCompare(b.name)),
      ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
      modelSettingsVersion: 1,
    }
  }

  async getModels(providerId: string): Promise<ModelDescriptor[]> {
    return this.runtime.getModels(providerId)
  }

  getModelDescriptor(selection: ModelSelection): ModelDescriptor | undefined {
    return this.runtime.getModelDescriptor(selection)
  }

  getModelFingerprint(selection: ModelSelection): string | undefined {
    const model = this.runtime.getModel(selection)
    const descriptor = this.runtime.getModelDescriptor(selection)
    if (model === undefined || descriptor === undefined) return undefined
    return JSON.stringify({
      descriptor,
      baseUrl: model.baseUrl,
      providerName: model.provider,
    })
  }

  streamSimple(
    selection: ModelSelection,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const model = this.runtime.getModel(selection)
    if (model === undefined) throw new Error('Selected model is not available')
    const ark = selection.providerId === 'volcengine-ark'
      || model.baseUrl.includes('ark.cn-beijing.volces.com')
    if (!ark) return this.runtime.streamSimple(selection, context, options)

    const originalOnPayload = options?.onPayload
    return this.runtime.streamSimple(selection, context, {
      ...options,
      cacheRetention: 'none',
      onPayload: async (payload, selectedModel) => {
        const transformed = originalOnPayload === undefined
          ? payload
          : await originalOnPayload(payload, selectedModel)
        if (!isRecord(transformed)) return transformed
        const sanitized = { ...transformed }
        delete sanitized.prompt_cache_key
        delete sanitized.prompt_cache_retention
        delete sanitized.prompt_cache_options
        delete sanitized.store
        return sanitized
      },
    })
  }

  async testModel(selection: ModelSelection): Promise<ModelTestResult> {
    const startedAt = Date.now()
    try {
      const signal = AbortSignal.timeout(45_000)
      const stream = this.streamSimple(selection, normalizeContext({
        messages: [{
          role: 'user',
          content: 'Reply with exactly: OK',
          timestamp: Date.now(),
        }],
      }), {
        maxTokens: 64,
        cacheRetention: 'none',
        signal,
      })
      let text = ''
      for await (const event of stream) {
        if (event.type === 'text_delta') text += event.delta
        if (event.type === 'error') {
          throw new Error(event.error.errorMessage ?? 'Model request failed')
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        text: text.trim() || 'Connected',
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async saveCredential(providerId: string, apiKey: string): Promise<ModelConfigSnapshot> {
    const provider = this.runtime.getProviders().find((entry) => entry.id === providerId)
    if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`)
    if (apiKey.trim().length === 0) throw new Error('API key is required')

    await this.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key: apiKey.trim(),
    }))
    return this.getSnapshot()
  }

  async deleteCredential(providerId: string): Promise<ModelConfigSnapshot> {
    await this.credentials.delete(providerId)
    return this.getSnapshot()
  }

  async setDefault(selection: ModelSelection): Promise<ModelConfigSnapshot> {
    const model = this.runtime.getModel(selection)
    if (model === undefined) throw new Error('Selected model is not available')
    await this.settings.setDefault(selection)
    return this.getSnapshot()
  }

  async saveCustomProvider(config: CustomProviderConfig): Promise<ModelConfigSnapshot> {
    const normalized = normalizeCustomProvider(config)
    const current = await this.settings.read()
    if (this.runtime.getProviders().some((provider) => provider.id === normalized.id && !current.customProviders.some((entry) => entry.id === normalized.id))) {
      throw new Error('Custom provider ID conflicts with a built-in provider')
    }
    const next = await this.settings.upsertCustomProvider(normalized)
    this.runtime.replaceCustomProviders(next.customProviders)
    return this.getSnapshot()
  }

  async deleteCustomProvider(providerId: string): Promise<ModelConfigSnapshot> {
    const next = await this.settings.deleteCustomProvider(providerId)
    this.runtime.replaceCustomProviders(next.customProviders)
    await this.credentials.delete(providerId).catch(() => undefined)
    return this.getSnapshot()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeCustomProvider(config: CustomProviderConfig): CustomProviderConfig {
  let baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  if (config.api === 'openai-responses') baseUrl = baseUrl.replace(/\/responses$/, '')
  if (config.api === 'openai-completions') baseUrl = baseUrl.replace(/\/chat\/completions$/, '')
  return { ...config, baseUrl }
}
