import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { TooltipButton } from './components/TooltipButton'
import { Input } from './components/Input'
import { notifyError, notifySuccess, useErrorToast } from './notifications'
import {
  REASONING_EFFORTS,
  resolveReasoningEffort,
  type CustomProviderApi,
  type CustomModelConfig,
  type CustomProviderConfig,
  type ModelConfigSnapshot,
  type ModelDescriptor,
  type ModelInput,
  type ModelTestResult,
  type ReasoningEffort,
} from '../shared/models'

interface ModelSettingsProps {
  snapshot: ModelConfigSnapshot | undefined
  onSnapshot(value: ModelConfigSnapshot): void
  onClose?: () => void
  embedded?: boolean
}

export function ModelSettings({ snapshot, onSnapshot, onClose, embedded = false }: ModelSettingsProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string>()
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string>()
  const [testing, setTesting] = useState(false)

  useErrorToast(error)

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
        if (active) setError(errorMessage(reason, t))
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
      setError(errorMessage(reason, t))
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
      setError(errorMessage(reason, t))
    } finally {
      setBusy(false)
    }
  }

  async function chooseDefault(modelId: string): Promise<void> {
    if (selectedProviderId === undefined) return
    const model = models.find((entry) => entry.id === modelId)
    const preferredEffort = snapshot?.defaultModel?.providerId === selectedProviderId
      && snapshot.defaultModel.modelId === modelId
      ? snapshot.defaultReasoningEffort
      : undefined
    setBusy(true)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.setDefault({
        providerId: selectedProviderId,
        modelId,
        reasoningEffort: resolveReasoningEffort(preferredEffort, model?.reasoningEfforts ?? []),
      }))
    } catch (reason) {
      setError(errorMessage(reason, t))
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
      notifyError(t('settings.selectModelFirst'))
      return
    }
    setTesting(true)
    try {
      const result = await window.barn.models.testModel(selection)
      if (result.ok) {
        notifySuccess(t('settings.connectionSucceededMs', { latency: result.latencyMs, text: result.text ?? 'OK' }))
      } else {
        notifyError(result.error ?? t('settings.connectionFailed'))
      }
    } catch (reason) {
      notifyError(errorMessage(reason, t))
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
      setError(errorMessage(reason, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={embedded ? 'model-settings-embedded' : 'settings-backdrop'}
      role={embedded ? undefined : 'presentation'}
      onMouseDown={embedded ? undefined : onClose}
    >
      <section
        className={embedded ? 'model-settings-page' : 'settings-panel'}
        {...(embedded ? {} : { role: 'dialog', 'aria-modal': true })}
        aria-label={t('settings.label')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!embedded && (
          <header className="settings-header">
            <div>
              <span>{t('settings.desktopConfiguration')}</span>
              <h2>{t('settings.title')}</h2>
            </div>
            <TooltipButton className="icon-button" label={t('settings.close')} onClick={onClose}>
              <X size={18} />
            </TooltipButton>
          </header>
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
                if (testResult.ok) {
                  notifySuccess(t('settings.connectionSucceeded', { latency: testResult.latencyMs }))
                } else {
                  notifyError(testResult.error ?? t('settings.connectionTestFailed'))
                }
              }
            }}
          />
        ) : (
          <div className={embedded ? 'settings-grid embedded' : 'settings-grid'}>
            <div className="provider-column">
              <div className="provider-search">
                <Search size={15} />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('settings.searchProviders')}
                  aria-label={t('settings.searchProviders')}
                  appearance="flush"
                  density="compact"
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
                      <small>{provider.kind === 'custom' ? t('settings.customEndpoint') : provider.id}</small>
                    </span>
                    <span className="provider-count">{provider.modelCount}</span>
                  </button>
                ))}
                {providers.length === 0 && <p className="muted-row">{t('settings.noMatchingProviders')}</p>}
              </div>
              <button className="secondary-button full-width" type="button" onClick={() => {
                setEditingProviderId(undefined)
                setCreating(true)
              }}>
                <Plus size={15} />
                {t('settings.addProvider')}
              </button>
            </div>

            <div className="provider-detail">
              {selectedProvider === undefined ? (
                <div className="detail-empty">{t('settings.selectProvider')}</div>
              ) : (
                <>
                  <div className="detail-heading">
                    <div>
                      <span>{selectedProvider.kind === 'custom' ? t('settings.customProvider') : t('settings.builtInProvider')}</span>
                      <h3>{selectedProvider.name}</h3>
                    </div>
                    <div className={selectedProvider.configured ? 'status-pill ready' : 'status-pill'}>
                      {selectedProvider.configured ? <Check size={13} /> : <KeyRound size={13} />}
                      {selectedProvider.configured ? t('settings.configured') : t('settings.needsKey')}
                    </div>
                  </div>

                  <label className="field-label" htmlFor="api-key">{t('settings.apiKey')}</label>
                  <div className="secret-row">
                    <Input
                      id="api-key"
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={selectedProvider.configured ? t('settings.replaceStoredKey') : t('settings.enterProviderKey')}
                      autoComplete="off"
                      density="compact"
                    />
                    <button
                      className="primary-button"
                      type="button"
                      disabled={apiKey.trim().length === 0 || busy}
                      onClick={() => void saveCredential()}
                    >
                      {t('common.save')}
                    </button>
                  </div>
                  {selectedProvider.configured && (
                    <div className="credential-meta">
                      <span>{selectedProvider.authSource ?? t('settings.storedSecurely')}</span>
                      <button type="button" onClick={() => void deleteCredential()}>
                        <Trash2 size={13} />
                        {t('settings.removeKey')}
                      </button>
                    </div>
                  )}

                  <div className="divider" />

                  <div className="detail-section-heading">
                    <div>
                      <span>{t('settings.defaultModel')}</span>
                      <strong>{snapshot?.defaultModel?.modelId ?? t('settings.notSelected')}</strong>
                    </div>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={testing || models.length === 0}
                      onClick={() => void testConnection()}
                    >
                      {testing ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
                      {t('settings.testConnection')}
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
                            {model.reasoning && <em>{t('settings.reasoning')}</em>}
                            {active && <Check size={15} />}
                          </span>
                        </button>
                      )
                    })}
                    {models.length === 0 && !busy && <p className="muted-row">{t('settings.noModels')}</p>}
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
                        {t('settings.editProvider')}
                      </button>
                      <button className="danger-button" type="button" onClick={() => void removeCustomProvider()}>
                        <Trash2 size={14} />
                        {t('settings.deleteCustomProvider')}
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
  reasoningEfforts: ReasoningEffort[]
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
  const { t } = useTranslation()
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

  useErrorToast(error)

  const modelsValid = draftModels.length > 0 && draftModels.every((model) => {
    return model.id.trim().length > 0
      && model.name.trim().length > 0
      && Number(model.contextWindow) > 0
      && Number(model.maxTokens) > 0
      && model.input.length > 0
      && (!model.reasoning || model.reasoningEfforts.length > 0)
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
      if (providerId === undefined) throw new Error(t('settings.providerIdRequired'))
      const models: CustomModelConfig[] = draftModels.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim() || model.id.trim(),
        contextWindow: Number(model.contextWindow),
        maxTokens: Number(model.maxTokens),
        reasoning: model.reasoning,
        reasoningEfforts: model.reasoning ? model.reasoningEfforts : [],
        input: model.input,
      }))
      const selectedModelId = models.some((model) => model.id === defaultModelId)
        ? defaultModelId
        : models[0]?.id
      if (selectedModelId === undefined) throw new Error(t('settings.atLeastOneModel'))

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
        const selectedModel = models.find((model) => model.id === selectedModelId)
        snapshot = await window.barn.models.setDefault({
          providerId,
          modelId: selectedModelId,
          reasoningEffort: resolveReasoningEffort(undefined, selectedModel?.reasoningEfforts ?? []),
        })
      }
      const testResult = testAfterSave
        ? await window.barn.models.testModel({ providerId, modelId: selectedModelId })
        : undefined
      onSaved(snapshot, providerId, testResult)
    } catch (reason) {
      setError(errorMessage(reason, t))
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
      reasoningEfforts: [],
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
      reasoningEfforts: [],
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

  function toggleReasoningEffort(key: string, effort: ReasoningEffort): void {
    setDraftModels((current) => current.map((model) => {
      if (model.key !== key) return model
      const reasoningEfforts = model.reasoningEfforts.includes(effort)
        ? model.reasoningEfforts.filter((entry) => entry !== effort)
        : [...model.reasoningEfforts, effort]
      return { ...model, reasoningEfforts }
    }))
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
          {t('settings.providers')}
        </button>
        <div className="form-heading">
          <span>{mode === 'edit' ? t('settings.providerConfiguration') : t('settings.providerSetup')}</span>
          <h3>{mode === 'edit' ? t('settings.editProviderTitle', { name: initialProvider?.name ?? t('settings.customProvider') }) : t('settings.addProviderTitle')}</h3>
        </div>
        {mode === 'create' && (
          <button className="preset-card ark" type="button" onClick={applyArkPreset}>
            <span>{t('settings.quickSetup')}</span>
            <strong>Volcengine Ark</strong>
            <small>Responses API · DeepSeek V4.1 Flash</small>
          </button>
        )}
        <div className="form-grid">
          <label>
            <span>{t('settings.providerId')}</span>
            <Input
              value={id}
              readOnly={mode === 'edit'}
              onChange={(event) => setId(event.target.value)}
              placeholder="acme-gateway"
              density="compact"
            />
          </label>
          <label>
            <span>{t('settings.displayName')}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme Gateway" density="compact" />
          </label>
          <label className="span-two">
            <span>{t('settings.baseUrl')}</span>
            <Input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://gateway.example/v1" density="compact" />
          </label>
          <label className="span-two">
            <span>{t('settings.protocol')}</span>
            <select value={api} onChange={(event) => setApi(event.target.value as CustomProviderApi)}>
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
          <label className="span-two">
            <span>{t('settings.apiKey')}</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={providerConfigured ? t('settings.leaveBlankForStoredKey') : t('settings.pasteProviderKey')}
              autoComplete="off"
              density="compact"
            />
          </label>
        </div>

        <div className="model-editor-heading">
          <div>
            <span>{t('settings.modelConfiguration')}</span>
            <strong>{t('common.models', { count: draftModels.length })}</strong>
          </div>
          <button className="secondary-button compact" type="button" onClick={addModel}>
            <Plus size={13} />
            {t('settings.addModel')}
          </button>
        </div>

        <div className="model-editor-list">
          {draftModels.map((model, index) => (
            <section className="model-editor-card" key={model.key}>
              <div className="model-editor-card-header">
                <span>{t('settings.modelNumber', { number: index + 1 })}</span>
                <TooltipButton
                  className="icon-button danger"
                  label={t('settings.removeModel')}
                  disabled={draftModels.length <= 1}
                  onClick={() => removeModel(model.key)}
                >
                  <Trash2 size={14} />
                </TooltipButton>
              </div>
              <div className="model-editor-grid">
                <label>
                  <span>{t('settings.modelId')}</span>
                  <Input value={model.id} onChange={(event) => updateModel(model.key, { id: event.target.value })} placeholder="model-id" density="compact" />
                </label>
                <label>
                  <span>{t('settings.modelName')}</span>
                  <Input value={model.name} onChange={(event) => updateModel(model.key, { name: event.target.value })} placeholder={t('settings.modelName')} density="compact" />
                </label>
                <label>
                  <span>{t('settings.contextWindow')}</span>
                  <Input inputMode="numeric" value={model.contextWindow} onChange={(event) => updateModel(model.key, { contextWindow: event.target.value })} density="compact" />
                </label>
                <label>
                  <span>{t('settings.maxOutput')}</span>
                  <Input inputMode="numeric" value={model.maxTokens} onChange={(event) => updateModel(model.key, { maxTokens: event.target.value })} density="compact" />
                </label>
                <div className="option-row span-two">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={model.reasoning}
                      onChange={(event) => updateModel(model.key, {
                        reasoning: event.target.checked,
                        reasoningEfforts: event.target.checked
                          ? model.reasoningEfforts.length > 0
                            ? model.reasoningEfforts
                            : ['low', 'medium', 'high']
                          : [],
                      })}
                    />
                    {t('settings.reasoningModel')}
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={model.input.includes('image')} onChange={() => toggleInput(model.key, 'image')} />
                    {t('settings.imageInput')}
                  </label>
                </div>
                {model.reasoning && (
                  <div className="effort-config span-two">
                    <span>{t('settings.supportedEfforts')}</span>
                    <div className="effort-config-options">
                      {REASONING_EFFORTS.map((effort) => {
                        const active = model.reasoningEfforts.includes(effort)
                        return (
                          <button
                            className={active ? 'effort-config-option active' : 'effort-config-option'}
                            type="button"
                            key={effort}
                            aria-pressed={active}
                            onClick={() => toggleReasoningEffort(model.key, effort)}
                          >
                            <span />
                            {t(`settings.efforts.${effort}`)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>

        <div className="form-grid">
          <label className="span-two">
            <span>{t('settings.defaultModel')}</span>
            <select value={defaultModelId} onChange={(event) => setDefaultModelId(event.target.value)}>
              {draftModels.map((model) => (
                <option value={model.id} key={model.key} disabled={model.id.trim().length === 0}>
                  {model.name || model.id || t('settings.unnamedModel')}
                </option>
              ))}
            </select>
          </label>
          <div className="span-two option-row">
            <label className="check-row">
              <input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
              {t('settings.useAsDefault')}
            </label>
            <label className="check-row">
              <input type="checkbox" checked={testAfterSave} onChange={(event) => setTestAfterSave(event.target.checked)} />
              {t('settings.testAfterSave')}
            </label>
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          className="primary-button"
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {busy && <LoaderCircle className="spin" size={14} />}
          {busy ? t('settings.configuring') : mode === 'edit' ? t('settings.saveChanges') : t('settings.saveAndTest')}
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
    reasoningEfforts: [...model.reasoningEfforts],
    input: [...model.input],
  }
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  return `${Math.round(tokens / 1_000)}K`
}

function errorMessage(reason: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  const translate = t as (key: string) => string
  return reason instanceof Error ? reason.message : translate('settings.modelOperationFailed')
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
      reasoningEfforts: model.reasoningEfforts,
      input: model.input,
    })),
  }
}
