import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { CustomProviderConfig, ModelTestInput } from '../shared/models'
import type { ModelService } from './models/model-service'

const customModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  contextWindow: z.number().int().positive().max(10_000_000),
  maxTokens: z.number().int().positive().max(1_000_000),
  reasoning: z.boolean(),
  input: z.array(z.enum(['text', 'image'])).min(1),
})

const customProviderSchema: z.ZodType<CustomProviderConfig> = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  models: z.array(customModelSchema).min(1).max(100),
})

export function registerModelIpc(
  models: ModelService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('models:get-snapshot', guard(isTrustedSender, () => models.getSnapshot()))

  ipcMain.handle('models:get-models', guard(isTrustedSender, (_event, providerId: unknown) => {
    return models.getModels(z.string().min(1).parse(providerId))
  }))

  ipcMain.handle('models:save-credential', guard(isTrustedSender, (_event, input: unknown) => {
    const parsed = z.object({
      providerId: z.string().min(1),
      apiKey: z.string().min(1).max(20_000),
    }).parse(input)
    return models.saveCredential(parsed.providerId, parsed.apiKey)
  }))

  ipcMain.handle('models:delete-credential', guard(isTrustedSender, (_event, providerId: unknown) => {
    return models.deleteCredential(z.string().min(1).parse(providerId))
  }))

  ipcMain.handle('models:set-default', guard(isTrustedSender, (_event, input: unknown) => {
    const parsed = z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
    }).parse(input)
    return models.setDefault(parsed)
  }))

  ipcMain.handle('models:save-custom-provider', guard(isTrustedSender, (_event, input: unknown) => {
    return models.saveCustomProvider(customProviderSchema.parse(input))
  }))

  ipcMain.handle('models:delete-custom-provider', guard(isTrustedSender, (_event, providerId: unknown) => {
    return models.deleteCustomProvider(z.string().min(1).parse(providerId))
  }))

  ipcMain.handle('models:test', guard(isTrustedSender, (_event, input: unknown) => {
    const parsed = z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
    }).parse(input) as ModelTestInput
    return models.testModel(parsed)
  }))
}

function guard(
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  operation: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown,
) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    return operation(event, ...args)
  }
}
