import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  Sparkles,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type {
  CustomProviderApi,
  CustomModelConfig,
  CustomProviderConfig,
  ModelConfigSnapshot,
  ModelDescriptor,
  ModelInput,
  ModelTestResult,
} from '../shared/models'

interface ModelSettingsProps {
  snapshot: ModelConfigSnapshot | undefined
  onSnapshot(value: ModelConfigSnapshot): void
  onClose(): void
}

export function ModelSettings({ snapshot, onSnapshot, onClose }: ModelSettingsProps) {
  const [query, setQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string>()
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; message: string }>()
  const [creating, setCreating] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string>()
  const [testing, setTesting] = useState(false)

  const providers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized.length === 0) return snapshot?.providers ?? []
    return (snapshot?.providers ?? []).filter((provider) => {
      return provider.name.toLowerCase().includes(normalized)
        || provider.id.toLowerCase().includes(normalized)
    })
  }, [query, snapshot?.providers])

  const selectedProvider = snapshot?.providers.find(
    (provider) => provider.id === selectedProviderId,
  )

  useEffect(() => {
    if (selectedProviderId !== undefined) return
    const preferred = snapshot?.defaultModel?.providerId
      ?? snapshot?.providers.find((provider) => provider.configured)?.id
      ?? snapshot?.providers[0]?.id
    if (preferred !== undefined) setSelectedProviderId(preferred)
  }, [selectedProviderId, snapshot])

  useEffect(() => {
    if (selectedProviderId === undefined) {
      setModels([])
      return
    }
    let active = true
    setBusy(true)
    setError(undefined)
    void window.barn.models.getModels(selectedProviderId)
      .then((value) => {
        if (active) setModels(value)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason))
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [selectedProviderId])

  async function saveCredential(): Promise<void> {
    if (selectedProviderId === undefined || apiKey.trim().length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await window.barn.models.saveCredential({
        providerId: selectedProviderId,
        apiKey,
      })
      setApiKey('')
      onSnapshot(next)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function deleteCredential(): Promise<void> {
    if (selectedProviderId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.deleteCredential(selectedProviderId))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function chooseDefault(modelId: string): Promise<void> {
    if (selectedProviderId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.setDefault({
        providerId: selectedProviderId,
        modelId,
      }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (selectedProvider === undefined) return
    const selection = snapshot?.defaultModel?.providerId === selectedProvider.id
      ? snapshot.defaultModel
      : models[0] === undefined
        ? undefined
        : { providerId: selectedProvider.id, modelId: models[0].id }
    if (selection === undefined) {
      setNotice({ kind: 'error', message: 'Select a model before testing.' })
      return
    }
    setTesting(true)
    setNotice(undefined)
    try {
      const result = await window.barn.models.testModel(selection)
      setNotice(result.ok
        ? { kind: 'ok', message: `Connection succeeded in ${result.latencyMs} ms: ${result.text ?? 'OK'}` }
        : { kind: 'error', message: result.error ?? 'Connection failed' })
    } catch (reason) {
      setNotice({ kind: 'error', message: errorMessage(reason) })
    } finally {
      setTesting(false)
    }
  }

  async function removeCustomProvider(): Promise<void> {
    if (selectedProvider === undefined || selectedProvider.kind !== 'custom') return
    setBusy(true)
    try {
      const next = await window.barn.models.deleteCustomProvider({
        providerId: selectedProvider.id,
      })
      onSnapshot(next)
      setSelectedProviderId(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Model settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span>Desktop configuration</span>
            <h2>Models</h2>
          </div>
          <button className="icon-button" type="button" title="Close settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {error !== undefined && <div className="settings-error" role="alert">{error}</div>}
        {notice !== undefined && (
          <div className={notice.kind === 'ok' ? 'settings-notice success' : 'settings-notice'} role="status">
            {notice.message}
          </div>
        )}

        {creating || editingProviderId !== undefined ? (
          <CustomProviderForm
            key={editingProviderId ?? 'new-provider'}
            mode={editingProviderId === undefined ? 'create' : 'edit'}
            initialProvider={editingProviderId === undefined
              ? undefined
              : providerConfigFrom(editingProviderId, snapshot, models)}
            providerConfigured={selectedProvider?.configured ?? false}
            initialDefaultModelId={snapshot?.defaultModel?.providerId === editingProviderId
              ? snapshot?.defaultModel?.modelId
              : undefined}
            onCancel={() => {
              setCreating(false)
              setEditingProviderId(undefined)
            }}
            onSaved={(next, providerId, testResult) => {
              onSnapshot(next)
              setSelectedProviderId(providerId)
              setCreating(false)
              setEditingProviderId(undefined)
              void window.barn.models.getModels(providerId).then(setModels).catch(() => undefined)
              if (testResult !== undefined) {
                setNotice(testResult.ok
                  ? { kind: 'ok', message: `Connection succeeded in ${testResult.latencyMs} ms.` }
                  : { kind: 'error', message: testResult.error ?? 'Connection test failed' })
              }
            }}
          />
        ) : (
          <div className="settings-grid">
            <div className="provider-column">
              <div className="provider-search">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search providers"
                  aria-label="Search providers"
                />
              </div>
              <div className="provider-list">
                {providers.map((provider) => (
                  <button
                    className={provider.id === selectedProviderId ? 'provider-row selected' : 'provider-row'}
                    type="button"
                    key={provider.id}
                    onClick={() => setSelectedProviderId(provider.id)}
                  >
                    <span className={provider.configured ? 'provider-dot configured' : 'provider-dot'} />
                    <span className="provider-copy">
                      <strong>{provider.name}</strong>
                      <small>{provider.kind === 'custom' ? 'Custom endpoint' : provider.id}</small>
                    </span>
                    <span className="provider-count">{provider.modelCount}</span>
                  </button>
                ))}
                {providers.length === 0 && <p className="muted-row">No matching providers</p>}
              </div>
              <button className="secondary-button full-width" type="button" onClick={() => {
                setEditingProviderId(undefined)
                setCreating(true)
              }}>
                <Plus size={15} />
                Add provider
              </button>
            </div>

            <div className="provider-detail">
              {selectedProvider === undefined ? (
                <div className="detail-empty">Select a provider</div>
              ) : (
                <>
                  <div className="detail-heading">
                    <div>
                      <span>{selectedProvider.kind === 'custom' ? 'Custom provider' : 'Built-in provider'}</span>
                      <h3>{selectedProvider.name}</h3>
                    </div>
                    <div className={selectedProvider.configured ? 'status-pill ready' : 'status-pill'}>
                      {selectedProvider.configured ? <Check size={13} /> : <KeyRound size={13} />}
                      {selectedProvider.configured ? 'Configured' : 'Needs key'}
                    </div>
                  </div>

                  <label className="field-label" htmlFor="api-key">API key</label>
                  <div className="secret-row">
                    <input
                      id="api-key"
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={selectedProvider.configured ? 'Replace stored key' : 'Enter provider key'}
                      autoComplete="off"
                    />
                    <button
                      className="primary-button"
                      type="button"
                      disabled={apiKey.trim().length === 0 || busy}
                      onClick={() => void saveCredential()}
                    >
                      Save
                    </button>
                  </div>
                  {selectedProvider.configured && (
                    <div className="credential-meta">
                      <span>{selectedProvider.authSource ?? 'Stored securely'}</span>
                      <button type="button" onClick={() => void deleteCredential()}>
                        <Trash2 size={13} />
                        Remove key
                      </button>
                    </div>
                  )}

                  <div className="divider" />

                  <div className="detail-section-heading">
                    <div>
                      <span>Default model</span>
                      <strong>{snapshot?.defaultModel?.modelId ?? 'Not selected'}</strong>
                    </div>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={testing || models.length === 0}
                      onClick={() => void testConnection()}
                    >
                      {testing ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
                      Test connection
                    </button>
                  </div>

                  <div className="model-list">
                    {models.map((model) => {
                      const active = snapshot?.defaultModel?.providerId === selectedProvider.id
                        && snapshot.defaultModel.modelId === model.id
                      return (
                        <button
                          className={active ? 'model-row active' : 'model-row'}
                          type="button"
                          key={model.id}
                          onClick={() => void chooseDefault(model.id)}
                        >
                          <span>
                            <strong>{model.name}</strong>
                            <small>{model.id} · {model.api}</small>
                          </span>
                          <span className="model-facts">
                            {formatContext(model.contextWindow)}
                            {model.reasoning && <em>Reasoning</em>}
                            {active && <Check size={15} />}
                          </span>
                        </button>
                      )
                    })}
                    {models.length === 0 && !busy && <p className="muted-row">No models listed</p>}
                  </div>

                  {selectedProvider.kind === 'custom' && (
                    <div className="provider-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={models.length === 0}
                        onClick={() => {
                          setCreating(false)
                          setEditingProviderId(selectedProvider.id)
                        }}
                      >
                        Edit provider
                      </button>
                      <button className="danger-button" type="button" onClick={() => void removeCustomProvider()}>
                        <Trash2 size={14} />
                        Delete custom provider
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

interface CustomProviderFormProps {
  mode: 'create' | 'edit'
  initialProvider?: CustomProviderConfig | undefined
  providerConfigured: boolean
  initialDefaultModelId?: string | undefined
  onCancel(): void
  onSaved(snapshot: ModelConfigSnapshot, providerId: string, testResult?: ModelTestResult): void
}

interface EditableModel {
  key: string
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
  input: ModelInput[]
}

const ARK_PRESET = {
  id: 'volcengine-ark',
  name: 'Volcengine Ark',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  api: 'openai-responses' as CustomProviderApi,
  modelId: 'deepseek-v4-1-flash-261017',
  modelName: 'DeepSeek V4.1 Flash',
  contextWindow: '262144',
  maxTokens: '32768',
}

function CustomProviderForm({
  mode,
  initialProvider,
  providerConfigured,
  initialDefaultModelId,
  onCancel,
  onSaved,
}: CustomProviderFormProps) {
  const initialModels = initialProvider?.models ?? []
  const [id, setId] = useState(initialProvider?.id ?? '')
  const [name, setName] = useState(initialProvider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initialProvider?.baseUrl ?? '')
  const [api, setApi] = useState<CustomProviderApi>(initialProvider?.api ?? 'openai-responses')
  const [draftModels, setDraftModels] = useState<EditableModel[]>(() => initialModels.map(toEditableModel))
  const [defaultModelId, setDefaultModelId] = useState(
    initialDefaultModelId ?? initialModels[0]?.id ?? '',
  )
  const [apiKey, setApiKey] = useState('')
  const [makeDefault, setMakeDefault] = useState(initialDefaultModelId !== undefined || initialProvider === undefined)
  const [testAfterSave, setTestAfterSave] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const modelsValid = draftModels.length > 0 && draftModels.every((model) => {
    return model.id.trim().length > 0
      && model.name.trim().length > 0
      && Number(model.contextWindow) > 0
      && Number(model.maxTokens) > 0
      && model.input.length > 0
  })
  const canSave = !busy
    && name.trim().length > 0
    && baseUrl.trim().length > 0
    && modelsValid
    && (!testAfterSave || providerConfigured || apiKey.trim().length > 0)

  async function save(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const providerId = mode === 'edit' ? initialProvider?.id : (id.trim() || slugify(name))
      if (providerId === undefined) throw new Error('Provider ID is required')
      const models: CustomModelConfig[] = draftModels.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim() || model.id.trim(),
        contextWindow: Number(model.contextWindow),
        maxTokens: Number(model.maxTokens),
        reasoning: model.reasoning,
        input: model.input,
      }))
      const selectedModelId = models.some((model) => model.id === defaultModelId)
        ? defaultModelId
        : models[0]?.id
      if (selectedModelId === undefined) throw new Error('At least one model is required')

      let snapshot = await window.barn.models.saveCustomProvider({
        id: providerId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        api,
        models,
      })
      if (apiKey.trim().length > 0) {
        snapshot = await window.barn.models.saveCredential({ providerId, apiKey })
      }
      const defaultStillExists = initialDefaultModelId === undefined
        || models.some((model) => model.id === initialDefaultModelId)
      if (makeDefault || !defaultStillExists) {
        snapshot = await window.barn.models.setDefault({
          providerId,
          modelId: selectedModelId,
        })
      }
      const testResult = testAfterSave
        ? await window.barn.models.testModel({ providerId, modelId: selectedModelId })
        : undefined
      onSaved(snapshot, providerId, testResult)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  function applyArkPreset(): void {
    setId(ARK_PRESET.id)
    setName(ARK_PRESET.name)
    setBaseUrl(ARK_PRESET.baseUrl)
    setApi(ARK_PRESET.api)
    const model = toEditableModel({
      id: ARK_PRESET.modelId,
      name: ARK_PRESET.modelName,
      contextWindow: Number(ARK_PRESET.contextWindow),
      maxTokens: Number(ARK_PRESET.maxTokens),
      reasoning: false,
      input: ['text'],
    })
    setDraftModels([model])
    setDefaultModelId(model.id)
  }

  function addModel(): void {
    const model = toEditableModel({
      id: '',
      name: '',
      contextWindow: 128_000,
      maxTokens: 32_000,
      reasoning: false,
      input: ['text'],
    })
    setDraftModels((current) => [...current, model])
    if (defaultModelId.length === 0) setDefaultModelId(model.id)
  }

  function updateModel(key: string, patch: Partial<EditableModel>): void {
    const previous = draftModels.find((model) => model.key === key)
    setDraftModels((current) => current.map((model) => model.key === key
      ? { ...model, ...patch }
      : model))
    if (patch.id !== undefined && previous?.id === defaultModelId) {
      setDefaultModelId(patch.id)
    }
  }

  function removeModel(key: string): void {
    if (draftModels.length <= 1) return
    const removed = draftModels.find((model) => model.key === key)
    const next = draftModels.filter((model) => model.key !== key)
    setDraftModels(next)
    if (removed?.id === defaultModelId) setDefaultModelId(next[0]?.id ?? '')
  }

  function toggleInput(key: string, value: ModelInput): void {
    setDraftModels((current) => current.map((model) => {
      if (model.key !== key) return model
      const input = model.input.includes(value)
        ? model.input.length === 1 ? model.input : model.input.filter((entry) => entry !== value)
        : [...model.input, value]
      return { ...model, input }
    }))
  }

  return (
    <div className="custom-provider-form">
      <div className="custom-provider-scroll">
        <button className="back-button" type="button" onClick={onCancel}>
          <ChevronLeft size={15} />
          Providers
        </button>
        <div className="form-heading">
          <span>{mode === 'edit' ? 'Provider configuration' : 'Provider setup'}</span>
          <h3>{mode === 'edit' ? `Edit ${initialProvider?.name ?? 'provider'}` : 'Add a model provider'}</h3>
        </div>
        {error !== undefined && <div className="settings-error">{error}</div>}
        {mode === 'create' && (
          <button className="preset-card ark" type="button" onClick={applyArkPreset}>
            <span>Quick setup</span>
            <strong>Volcengine Ark</strong>
            <small>Responses API · DeepSeek V4.1 Flash</small>
          </button>
        )}
        <div className="form-grid">
          <label>
            <span>Provider ID</span>
            <input
              value={id}
              readOnly={mode === 'edit'}
              onChange={(event) => setId(event.target.value)}
              placeholder="acme-gateway"
            />
          </label>
          <label>
            <span>Display name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme Gateway" />
          </label>
          <label className="span-two">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://gateway.example/v1" />
          </label>
          <label className="span-two">
            <span>Protocol</span>
            <select value={api} onChange={(event) => setApi(event.target.value as CustomProviderApi)}>
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
          <label className="span-two">
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={providerConfigured ? 'Leave blank to keep the stored key' : 'Paste the provider API key'}
              autoComplete="off"
            />
          </label>
        </div>

        <div className="model-editor-heading">
          <div>
            <span>Model configuration</span>
            <strong>{draftModels.length} {draftModels.length === 1 ? 'model' : 'models'}</strong>
          </div>
          <button className="secondary-button compact" type="button" onClick={addModel}>
            <Plus size={13} />
            Add model
          </button>
        </div>

        <div className="model-editor-list">
          {draftModels.map((model, index) => (
            <section className="model-editor-card" key={model.key}>
              <div className="model-editor-card-header">
                <span>Model {index + 1}</span>
                <button
                  className="icon-button danger"
                  type="button"
                  title="Remove model"
                  disabled={draftModels.length <= 1}
                  onClick={() => removeModel(model.key)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="model-editor-grid">
                <label>
                  <span>Model ID</span>
                  <input value={model.id} onChange={(event) => updateModel(model.key, { id: event.target.value })} placeholder="model-id" />
                </label>
                <label>
                  <span>Model name</span>
                  <input value={model.name} onChange={(event) => updateModel(model.key, { name: event.target.value })} placeholder="Model name" />
                </label>
                <label>
                  <span>Context window</span>
                  <input inputMode="numeric" value={model.contextWindow} onChange={(event) => updateModel(model.key, { contextWindow: event.target.value })} />
                </label>
                <label>
                  <span>Max output</span>
                  <input inputMode="numeric" value={model.maxTokens} onChange={(event) => updateModel(model.key, { maxTokens: event.target.value })} />
                </label>
                <div className="option-row span-two">
                  <label className="check-row">
                    <input type="checkbox" checked={model.reasoning} onChange={(event) => updateModel(model.key, { reasoning: event.target.checked })} />
                    Reasoning model
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={model.input.includes('image')} onChange={() => toggleInput(model.key, 'image')} />
                    Image input
                  </label>
                </div>
              </div>
            </section>
          ))}
        </div>

        <div className="form-grid">
          <label className="span-two">
            <span>Default model</span>
            <select value={defaultModelId} onChange={(event) => setDefaultModelId(event.target.value)}>
              {draftModels.map((model) => (
                <option value={model.id} key={model.key} disabled={model.id.trim().length === 0}>
                  {model.name || model.id || 'Unnamed model'}
                </option>
              ))}
            </select>
          </label>
          <div className="span-two option-row">
            <label className="check-row">
              <input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
              Use as default model
            </label>
            <label className="check-row">
              <input type="checkbox" checked={testAfterSave} onChange={(event) => setTestAfterSave(event.target.checked)} />
              Test connection after saving
            </label>
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
        <button
          className="primary-button"
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {busy && <LoaderCircle className="spin" size={14} />}
          {busy ? 'Configuring…' : mode === 'edit' ? 'Save changes' : 'Save and test'}
        </button>
      </div>
    </div>
  )
}

function toEditableModel(model: CustomModelConfig): EditableModel {
  return {
    key: `${model.id}:${Math.random().toString(36).slice(2)}`,
    id: model.id,
    name: model.name,
    contextWindow: String(model.contextWindow),
    maxTokens: String(model.maxTokens),
    reasoning: model.reasoning,
    input: [...model.input],
  }
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  return `${Math.round(tokens / 1_000)}K`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Model operation failed'
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-provider'
}

function providerConfigFrom(
  providerId: string,
  snapshot: ModelConfigSnapshot | undefined,
  models: ModelDescriptor[],
): CustomProviderConfig | undefined {
  const provider = snapshot?.providers.find((entry) => entry.id === providerId)
  if (provider === undefined || models.length === 0) return undefined
  const first = models[0]
  if (first === undefined) return undefined
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    api: first.api as CustomProviderApi,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: model.input,
    })),
  }
}
