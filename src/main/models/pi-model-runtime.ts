import {
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type CredentialStore,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  REASONING_EFFORTS,
  type CustomProviderConfig,
  type ModelDescriptor,
  type ModelSelection,
  type ReasoningEffort,
} from '../../shared/models'

const zeroCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const

export class PiModelRuntime {
  private readonly models
  private customProviderIds = new Set<string>()

  constructor(readonly credentialStore: CredentialStore) {
    this.models = builtinModels({
      credentials: credentialStore,
      identity: {
        attribution: {
          name: 'Barn Desktop',
          url: 'https://barn.local',
          categories: ['personal-agent'],
        },
      },
    })
  }

  replaceCustomProviders(configs: readonly CustomProviderConfig[]): void {
    for (const id of this.customProviderIds) this.models.deleteProvider(id)
    this.customProviderIds = new Set()

    for (const config of configs) {
      this.models.setProvider(buildCustomProvider(config))
      this.customProviderIds.add(config.id)
    }
  }

  getProviders(): readonly Provider[] {
    return this.models.getProviders()
  }

  getModels(providerId: string): ModelDescriptor[] {
    return this.models.getModels(providerId).map(toDescriptor)
  }

  getModel(selection: ModelSelection): Model<Api> | undefined {
    return this.models.getModel(selection.providerId, selection.modelId)
  }

  getModelDescriptor(selection: ModelSelection): ModelDescriptor | undefined {
    const model = this.getModel(selection)
    return model === undefined ? undefined : toDescriptor(model)
  }

  streamSimple(
    selection: ModelSelection,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const model = this.getModel(selection)
    if (model === undefined) throw new Error('Selected model is not available')
    return this.models.streamSimple(model, context, options)
  }

  async checkAuth(providerId: string): Promise<{ configured: boolean; source?: string }> {
    const result = await this.models.checkAuth(providerId)
    return {
      configured: result !== undefined,
      ...(result?.source === undefined ? {} : { source: result.source }),
    }
  }
}

function buildCustomProvider(config: CustomProviderConfig): Provider {
  const api = {
    'openai-completions': openAICompletionsApi(),
    'openai-responses': openAIResponsesApi(),
    'anthropic-messages': anthropicMessagesApi(),
  }

  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: `${config.name} API key`,
        async resolve(input) {
          const key = input.credential?.key
          return {
            auth: key === undefined ? {} : { apiKey: key },
            ...(key === undefined ? { source: 'keyless endpoint' } : { source: 'stored credential' }),
          }
        },
      },
    },
    models: config.models.map((model): Model<typeof config.api> => ({
      id: model.id,
      name: model.name,
      api: config.api,
      provider: config.id,
      baseUrl: config.baseUrl,
      reasoning: model.reasoning,
      ...(model.reasoning && model.reasoningEfforts.length > 0
        ? { thinkingLevelMap: customThinkingLevelMap(config.api, model.reasoningEfforts) }
        : {}),
      input: model.input,
      cost: zeroCost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
    api,
  })
}

function toDescriptor(model: Model<Api>): ModelDescriptor {
  return {
    id: model.id,
    name: model.name,
    providerId: model.provider,
    api: model.api,
    reasoning: model.reasoning,
    reasoningEfforts: model.reasoning
      ? getSupportedThinkingLevels(model).filter(isReasoningEffort)
      : [],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
  }
}

function customThinkingLevelMap(
  api: CustomProviderConfig['api'],
  efforts: readonly ReasoningEffort[],
): Record<ReasoningEffort | 'off', string | null> {
  const map = Object.fromEntries(
    REASONING_EFFORTS.map((effort) => [effort, efforts.includes(effort) ? effort : null]),
  ) as Record<ReasoningEffort, string | null>
  if (api === 'anthropic-messages' && map.minimal === 'minimal') map.minimal = 'low'
  return { off: null, ...map }
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value)
}
