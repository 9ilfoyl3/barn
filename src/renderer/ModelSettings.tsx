import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronLeft,
  KeyRound,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
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
  type ModelProviderSummary,
  type ModelTestResult,
  type ReasoningEffort,
} from '../shared/models'

interface ModelSettingsProps {
  snapshot: ModelConfigSnapshot | undefined
  onSnapshot(value: ModelConfigSnapshot): void
  onClose?: () => void
  embedded?: boolean
}

type ModelPageStep = 'overview' | 'providers' | 'connect' | 'custom'

export function ModelSettings({ snapshot, onSnapshot }: ModelSettingsProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<ModelPageStep>('overview')
  const [configuredModels, setConfiguredModels] = useState<ModelDescriptor[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | undefined>(snapshot?.defaultReasoningEffort)

  useErrorToast(error)

  useEffect(() => {
    let active = true
    void window.barn.models.getConfiguredModels()
      .then((models) => { if (active) setConfiguredModels(models) })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason, t)) })
    return () => { active = false }
  }, [snapshot, t])

  useEffect(() => {
    setReasoningEffort(snapshot?.defaultReasoningEffort)
  }, [snapshot?.defaultReasoningEffort])

  const providers = snapshot?.providers ?? []
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
  const selectedModel = configuredModels.find((model) =>
    model.providerId === snapshot?.defaultModel?.providerId && model.id === snapshot?.defaultModel?.modelId)
  const providerGroups = useMemo(() => groupProviders(providers), [providers])

  async function chooseDefault(model: ModelDescriptor): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const effort = model.providerId === snapshot?.defaultModel?.providerId && model.id === snapshot?.defaultModel?.modelId
        ? reasoningEffort
        : undefined
      const next = await window.barn.models.setDefault({
        providerId: model.providerId,
        modelId: model.id,
        reasoningEffort: resolveReasoningEffort(effort, model.reasoningEfforts),
      })
      onSnapshot(next)
      setReasoningEffort(next.defaultReasoningEffort)
      notifySuccess(t('settings.defaultModelSaved'))
    } catch (reason) {
      setError(errorMessage(reason, t))
    } finally {
      setBusy(false)
    }
  }

  async function saveEffort(effort: ReasoningEffort): Promise<void> {
    if (snapshot?.defaultModel === undefined) return
    setReasoningEffort(effort)
    setBusy(true)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.setDefault({ ...snapshot.defaultModel, reasoningEffort: effort }))
    } catch (reason) {
      setError(errorMessage(reason, t))
    } finally {
      setBusy(false)
    }
  }

  async function connectProvider(): Promise<void> {
    if (selectedProvider === undefined || apiKey.trim().length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.saveCredential({ providerId: selectedProvider.id, apiKey }))
      setApiKey('')
      setStep('overview')
      setSelectedProviderId(undefined)
      notifySuccess(t('settings.providerConnected', { name: selectedProvider.name }))
    } catch (reason) {
      setError(errorMessage(reason, t))
    } finally {
      setBusy(false)
    }
  }

  async function removeCredential(provider: ModelProviderSummary): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.deleteCredential(provider.id))
      notifySuccess(t('settings.credentialRemoved'))
    } catch (reason) {
      setError(errorMessage(reason, t))
    } finally {
      setBusy(false)
    }
  }

  function openProvider(provider: ModelProviderSummary): void {
    setSelectedProviderId(provider.id)
    setApiKey('')
    setError(undefined)
    if (provider.kind === 'custom') {
      setStep('custom')
    } else {
      setStep('connect')
    }
  }

  if (step === 'custom') {
    const provider = selectedProvider?.kind === 'custom' ? selectedProvider : undefined
    return (
      <div className="model-settings-page model-settings-wizard">
        <CustomProviderForm
          key={provider?.id ?? 'new-provider'}
          mode={provider === undefined ? 'create' : 'edit'}
          initialProvider={provider === undefined ? undefined : providerConfigFrom(provider.id, snapshot, configuredModels)}
          providerConfigured={provider?.configured ?? false}
          initialDefaultModelId={snapshot?.defaultModel?.providerId === provider?.id
            ? snapshot?.defaultModel?.modelId
            : undefined}
          onCancel={() => {
            setSelectedProviderId(undefined)
            setStep('providers')
          }}
          onSaved={(next, providerId, testResult) => {
            onSnapshot(next)
            setSelectedProviderId(undefined)
            setStep('overview')
            if (testResult !== undefined) {
              if (testResult.ok) notifySuccess(t('settings.connectionSucceeded', { latency: testResult.latencyMs }))
              else notifyError(testResult.error ?? t('settings.connectionTestFailed'))
            }
            void window.barn.models.getModels(providerId)
          }}
        />
      </div>
    )
  }

  if (step === 'connect' && selectedProvider !== undefined) {
    return (
      <div className="model-settings-page model-settings-wizard">
        <button className="model-wizard-back" type="button" onClick={() => setStep('providers')}>
          <ChevronLeft size={15} aria-hidden="true" />{t('settings.chooseProvider')}
        </button>
        <header className="model-wizard-heading">
          <h1>{t('settings.connectProvider', { name: selectedProvider.name })}</h1>
          <p>{t('settings.connectProviderDescription')}</p>
        </header>
        <section className="model-connect-card">
          <div className="model-connect-copy">
            <strong>{t('settings.apiKey')}</strong>
            <span>{t('settings.apiKeyStoredLocally')}</span>
          </div>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={selectedProvider.configured ? t('settings.replaceStoredKey') : t('settings.enterProviderKey')}
            autoComplete="off"
            aria-label={t('settings.apiKey')}
            density="compact"
          />
          {selectedProvider.configured && (
            <div className="model-connect-existing">
              <span>{selectedProvider.authSource ?? t('settings.configured')}</span>
              <button type="button" disabled={busy} onClick={() => void removeCredential(selectedProvider)}>
                <Trash2 size={13} aria-hidden="true" />{t('settings.removeKey')}
              </button>
            </div>
          )}
        </section>
        <div className="model-wizard-actions">
          <button
            className="primary-button"
            type="button"
            disabled={apiKey.trim().length === 0 || busy}
            onClick={() => void connectProvider()}
          >
            {busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <KeyRound size={14} aria-hidden="true" />}
            {busy ? t('settings.connecting') : t('settings.connect')}
          </button>
        </div>
      </div>
    )
  }

  if (step === 'providers') {
    return (
      <div className="model-settings-page model-settings-wizard">
        <button className="model-wizard-back" type="button" onClick={() => setStep('overview')}>
          <ChevronLeft size={15} aria-hidden="true" />{t('settings.modelsAndApi')}
        </button>
        <header className="model-wizard-heading">
          <h1>{t('settings.chooseProvider')}</h1>
          <p>{t('settings.chooseProviderDescription')}</p>
        </header>
        <div className="provider-choice-groups">
          {providerGroups.map((group) => (
            <section className="provider-choice-group" key={group.id}>
              <h3>{t(group.labelKey)}</h3>
              <div className="provider-choice-grid">
                {group.providers.map((provider) => (
                  <button type="button" key={provider.id} aria-label={provider.name} onClick={() => openProvider(provider)}>
                    <span className="provider-choice-mark">{providerInitial(provider.name)}</span>
                    <span>{provider.name}</span>
                    {provider.configured && <Check size={14} aria-label={t('settings.configured')} />}
                  </button>
                ))}
                {group.id === 'local' && (
                  <button type="button" onClick={() => setStep('custom')}>
                    <span className="provider-choice-mark"><Plus size={14} aria-hidden="true" /></span>
                    <span>{t('settings.customProvider')}</span>
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="model-settings-page model-settings-wizard">
      <header className="model-wizard-heading model-overview-heading">
        <h1>{t('settings.modelsAndApi')}</h1>
      </header>
      <div className="settings-groups model-overview-groups">
        <section className="settings-group">
          <h2>{t('settings.agentGroup')}</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-copy">
                <h3>{t('settings.defaultModel')}</h3>
                <p>{t('settings.defaultModelDescription')}</p>
              </div>
              <div className="settings-row-control">
                <select
                  className="settings-select model-default-select"
                  aria-label={t('settings.defaultModel')}
                  value={snapshot?.defaultModel === undefined ? '' : `${snapshot.defaultModel.providerId}:${snapshot.defaultModel.modelId}`}
                  onChange={(event) => {
                    const model = configuredModels.find((entry) => `${entry.providerId}:${entry.id}` === event.target.value)
                    if (model !== undefined) void chooseDefault(model)
                  }}
                >
                  {snapshot?.defaultModel === undefined && <option value="">{t('settings.notSelected')}</option>}
                  {configuredModels.map((model) => (
                    <option key={`${model.providerId}:${model.id}`} value={`${model.providerId}:${model.id}`}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <h3>{t('settings.reasoningEffort')}</h3>
                <p>{t('settings.reasoningEffortDescription')}</p>
              </div>
              <div className="settings-row-control">
                <select
                  className="settings-select"
                  aria-label={t('settings.reasoningEffort')}
                  value={reasoningEffort ?? ''}
                  disabled={selectedModel?.reasoning !== true}
                  onChange={(event) => void saveEffort(event.target.value as ReasoningEffort)}
                >
                  {selectedModel?.reasoning !== true && <option value="">{t('settings.notSupported')}</option>}
                  {selectedModel?.reasoningEfforts.map((effort) => (
                    <option key={effort} value={effort}>{t(`settings.efforts.${effort}`)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <h3>{t('settings.runLocation')}</h3>
                <p>{t('settings.runLocationDescription')}</p>
              </div>
              <div className="settings-row-control"><span className="settings-static-value">{t('settings.localDevice')}</span></div>
            </div>
          </div>
        </section>

        <section className="settings-group">
          <div className="model-library-heading">
            <h2>{t('settings.configuredModels')}</h2>
            {configuredModels.length > 0 && (
              <button className="settings-action-button" type="button" onClick={() => setStep('providers')}>
                <Plus size={14} aria-hidden="true" />{t('settings.addProvider')}
              </button>
            )}
          </div>
          <div className="settings-card model-library-card">
            {configuredModels.length === 0 ? (
              <div className="model-library-empty">
                <Sparkles size={18} aria-hidden="true" />
                <div>
                  <strong>{t('settings.noConfiguredModels')}</strong>
                  <p>{t('settings.noConfiguredModelsDescription')}</p>
                </div>
                <button className="settings-action-button" type="button" onClick={() => setStep('providers')}>
                  <Plus size={14} aria-hidden="true" />{t('settings.addProvider')}
                </button>
              </div>
            ) : configuredModels.map((model) => {
              const active = model.providerId === snapshot?.defaultModel?.providerId && model.id === snapshot?.defaultModel?.modelId
              return (
                <div className="model-library-row" key={`${model.providerId}:${model.id}`}>
                  <span className="provider-choice-mark">{providerInitial(providers.find((provider) => provider.id === model.providerId)?.name ?? model.providerId)}</span>
                  <div>
                    <strong>{model.name}</strong>
                    <p>{providers.find((provider) => provider.id === model.providerId)?.name ?? model.providerId}</p>
                  </div>
                  <span className="model-library-facts">{formatContext(model.contextWindow)}</span>
                  {active
                    ? <span className="model-default-badge"><Check size={13} aria-hidden="true" />{t('settings.defaultModel')}</span>
                    : <button className="settings-action-button" type="button" disabled={busy} onClick={() => void chooseDefault(model)}>{t('settings.useModel')}</button>}
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

type ProviderGroupLabelKey =
  | 'settings.providerGroupLocal'
  | 'settings.providerGroupMainstream'
  | 'settings.providerGroupChina'
  | 'settings.providerGroupAggregators'
  | 'settings.providerGroupCloud'
  | 'settings.providerGroupOther'

interface ProviderGroup {
  id: string
  labelKey: ProviderGroupLabelKey
  providers: ModelProviderSummary[]
}

function groupProviders(providers: ModelProviderSummary[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [
    { id: 'local', labelKey: 'settings.providerGroupLocal', providers: [] },
    { id: 'mainstream', labelKey: 'settings.providerGroupMainstream', providers: [] },
    { id: 'china', labelKey: 'settings.providerGroupChina', providers: [] },
    { id: 'aggregators', labelKey: 'settings.providerGroupAggregators', providers: [] },
    { id: 'cloud', labelKey: 'settings.providerGroupCloud', providers: [] },
    { id: 'other', labelKey: 'settings.providerGroupOther', providers: [] },
  ]
  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const provider of providers) {
    const id = provider.id.toLowerCase()
    const name = provider.name.toLowerCase()
    const group = provider.kind === 'custom' || id.includes('ollama')
      ? 'local'
      : /openai|anthropic|google|gemini|xai|mistral/.test(id)
        ? 'mainstream'
        : /deepseek|qwen|kimi|moonshot|zai|minimax|ant|baichuan|volcengine/.test(id) || /deepseek|qwen|kimi|moonshot|智谱|minimax|火山/.test(name)
          ? 'china'
          : /openrouter|github|vercel|cloudflare|opencode/.test(id)
            ? 'aggregators'
            : /azure|aws|bedrock|vertex/.test(id)
              ? 'cloud'
              : 'other'
    byId.get(group)?.providers.push(provider)
  }
  return groups.filter((group) => group.providers.length > 0 || group.id === 'local')
}

function providerInitial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase()
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
