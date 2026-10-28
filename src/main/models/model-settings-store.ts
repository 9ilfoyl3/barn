import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  CustomModelConfig,
  CustomProviderConfig,
  ModelSelection,
  ModelSettings,
} from '../../shared/models'

const selectionSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
})

const customModelSchema: z.ZodType<CustomModelConfig> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoning: z.boolean(),
  input: z.array(z.enum(['text', 'image'])).min(1),
})

const customProviderSchema: z.ZodType<CustomProviderConfig> = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  models: z.array(customModelSchema).min(1),
})

const settingsSchema: z.ZodType<ModelSettings> = z.object({
  version: z.literal(1),
  defaultModel: selectionSchema.optional(),
  customProviders: z.array(customProviderSchema),
})

const defaultSettings = (): ModelSettings => ({
  version: 1,
  customProviders: [],
})

export class ModelSettingsStore {
  readonly path: string

  constructor(directory: string) {
    this.path = join(directory, 'model-settings.json')
  }

  async read(): Promise<ModelSettings> {
    try {
      const raw = await readFile(this.path, 'utf8')
      return settingsSchema.parse(JSON.parse(raw))
    } catch (error) {
      if (isNotFound(error)) return defaultSettings()
      throw new Error(`Unable to read model settings at ${this.path}`, { cause: error })
    }
  }

  async setDefault(selection: ModelSelection): Promise<ModelSettings> {
    return this.update((current) => ({
      ...current,
      defaultModel: selectionSchema.parse(selection),
    }))
  }

  async upsertCustomProvider(provider: CustomProviderConfig): Promise<ModelSettings> {
    const parsed = customProviderSchema.parse(provider)
    return this.update((current) => ({
      ...current,
      customProviders: [
        ...current.customProviders.filter((entry) => entry.id !== parsed.id),
        parsed,
      ],
    }))
  }

  async deleteCustomProvider(providerId: string): Promise<ModelSettings> {
    return this.update((current) => {
      const defaultModel = current.defaultModel?.providerId === providerId
        ? undefined
        : current.defaultModel
      return {
        ...current,
        ...(defaultModel === undefined ? { defaultModel: undefined } : { defaultModel }),
        customProviders: current.customProviders.filter((entry) => entry.id !== providerId),
      }
    })
  }

  private async update(
    change: (settings: ModelSettings) => ModelSettings,
  ): Promise<ModelSettings> {
    const next = settingsSchema.parse(change(await this.read()))
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.path)
    return next
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}
