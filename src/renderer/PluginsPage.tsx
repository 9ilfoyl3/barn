import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Info,
  LoaderCircle,
  Mail,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type {
  ConnectorCapabilityDefinition,
  ConnectorConfig,
  ConnectorConfigValue,
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorSetupField,
  ConnectorTestResult,
} from '../shared/models'
import { SkillsPanel } from './SkillsPanel'
import { notifySuccess, useErrorToast } from './notifications'
import './plugins-page.css'

type PluginsTab = 'plugins' | 'skills'
type ConnectorCategory = 'integrations' | 'china'

interface EditorState {
  definition: ConnectorDefinition
  instance?: ConnectorInstance | undefined
}

const CATEGORY_ORDER: readonly ConnectorCategory[] = ['integrations', 'china']

export function PluginsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<PluginsTab>('plugins')
  const [query, setQuery] = useState('')
  const [definitions, setDefinitions] = useState<ConnectorDefinition[]>([])
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [selectedKind, setSelectedKind] = useState<string>()
  const [editor, setEditor] = useState<EditorState>()
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({})

  useErrorToast(error)

  useEffect(() => {
    void reload()
  }, [])

  const selectedDefinition = definitions.find((definition) => definition.kind === selectedKind)
  const selectedInstances = selectedDefinition === undefined
    ? []
    : instances.filter((instance) => instance.kind === selectedDefinition.kind)
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const filteredDefinitions = useMemo(() => definitions.filter((definition) => {
    if (normalizedQuery.length === 0) return true
    const name = translatedDefinitionName(definition, t)
    return `${name} ${definition.name} ${definition.description} ${definition.capabilities.map((capability) => capability.id).join(' ')}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  }), [definitions, normalizedQuery, t])

  const groupedDefinitions = useMemo(() => Object.fromEntries(
    CATEGORY_ORDER.map((category) => [
      category,
      filteredDefinitions.filter((definition) => connectorCategory(definition.kind) === category),
    ]),
  ) as Record<ConnectorCategory, ConnectorDefinition[]>, [filteredDefinitions])

  async function reload(): Promise<void> {
    try {
      const [nextDefinitions, nextInstances] = await Promise.all([
        window.barn.connectors.listDefinitions(),
        window.barn.connectors.list(),
      ])
      setDefinitions(nextDefinitions)
      setInstances(nextInstances)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function toggle(connector: ConnectorInstance): Promise<void> {
    setBusyId(connector.id)
    setError(undefined)
    try {
      await window.barn.connectors.update(connector.id, { enabled: !connector.enabled })
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  async function remove(connector: ConnectorInstance): Promise<void> {
    if (!window.confirm(t('connectorSettings.removeConfirm', { name: connector.name }))) return
    setBusyId(connector.id)
    setError(undefined)
    try {
      await window.barn.connectors.remove(connector.id)
      setTestResults((current) => {
        const next = { ...current }
        delete next[connector.id]
        return next
      })
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  async function test(connector: ConnectorInstance): Promise<void> {
    setBusyId(connector.id)
    setError(undefined)
    try {
      const result = await window.barn.connectors.test(connector.id)
      setTestResults((current) => ({ ...current, [connector.id]: result }))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  function openDefinition(definition: ConnectorDefinition, startCreating = false): void {
    setSelectedKind(definition.kind)
    setEditor(startCreating ? { definition } : undefined)
    setError(undefined)
  }

  function openEdit(connector: ConnectorInstance): void {
    const definition = definitions.find((entry) => entry.kind === connector.kind)
    if (definition === undefined) {
      setError(t('connectorSettings.unknownDefinition', { kind: connector.kind }))
      return
    }
    setSelectedKind(definition.kind)
    setEditor({ definition, instance: connector })
  }

  async function saveEditor(input: {
    name: string
    config: ConnectorConfig
    credentials: Record<string, string>
  }): Promise<void> {
    if (editor === undefined) return
    setBusyId(editor.instance?.id ?? 'new')
    setError(undefined)
    try {
      const connector = editor.instance === undefined
        ? await window.barn.connectors.create({
            kind: editor.definition.kind,
            name: input.name,
            config: input.config,
          })
        : await window.barn.connectors.update(editor.instance.id, {
            name: input.name,
            config: input.config,
          })
      if (Object.keys(input.credentials).length > 0) {
        await window.barn.connectors.saveCredentials({
          connectorId: connector.id,
          values: input.credentials,
        })
      }
      setSelectedKind(editor.definition.kind)
      setEditor(undefined)
      notifySuccess(t('connectorSettings.saved', { name: connector.name }))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  const catalog = (
    <div className="plugins-catalog">
      <h1 className="visually-hidden">{t('plugins.title')}</h1>
      <header className="plugins-heading">
        <div className="plugins-tabs" role="tablist" aria-label={t('plugins.title')}>
          {(['plugins', 'skills'] as const).map((tabId) => (
            <button
              aria-selected={tab === tabId}
              className={tab === tabId ? 'plugins-tab active' : 'plugins-tab'}
              key={tabId}
              onClick={() => {
                setTab(tabId)
                setQuery('')
              }}
              role="tab"
              type="button"
            >
              {tabId === 'plugins' ? t('plugins.title') : t('plugins.skills')}
            </button>
          ))}
        </div>
      </header>

      <label className="plugins-search">
        <Search size={17} aria-hidden="true" />
        <input
          aria-label={tab === 'skills' ? t('plugins.searchSkills') : t('plugins.search')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tab === 'skills' ? t('plugins.searchSkillsPlaceholder') : t('plugins.searchPlaceholder')}
          type="search"
          value={query}
        />
        {query.length > 0 && (
          <button type="button" aria-label={t('plugins.clearSearch')} onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        )}
      </label>

      {tab === 'skills' ? (
        <section role="tabpanel" aria-label={t('plugins.skills')}>
          <SkillsPanel query={query} />
        </section>
      ) : loading ? (
        <div className="plugins-loading" role="status">
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
          <span>{t('common.loading')}</span>
        </div>
      ) : (
        <div className="plugins-sections" role="tabpanel" aria-label={t('plugins.title')}>
          {normalizedQuery.length === 0 && (
            <section className="plugins-section" aria-labelledby="plugins-mcp-title">
              <div className="plugins-section-header">
                <h2 id="plugins-mcp-title">{t('plugins.mcpServers')}</h2>
                <button
                  className="plugins-section-link"
                  disabled
                  title={t('plugins.comingSoon')}
                  type="button"
                >
                  {t('plugins.addMcp')}
                </button>
              </div>
            </section>
          )}

          {CATEGORY_ORDER.map((category) => {
            const categoryDefinitions = groupedDefinitions[category]
            if (categoryDefinitions.length === 0) return null
            return (
              <PluginSection
                definitions={categoryDefinitions}
                instances={instances}
                key={category}
                onOpen={openDefinition}
                title={t(`plugins.categories.${category}`)}
              />
            )
          })}

          {filteredDefinitions.length === 0 && (
            <div className="plugins-no-results" role="status">
              <Search size={20} aria-hidden="true" />
              <span>{t('plugins.noResults')}</span>
            </div>
          )}

          <p className="plugins-safety-note">{t('plugins.safetyNote')}</p>
        </div>
      )}
    </div>
  )

  const detail = selectedDefinition === undefined ? undefined : (
    <div className="plugins-detail">
      <header className="plugins-detail-header">
        <button
          aria-label={t('plugins.back')}
          className="plugins-back"
          onClick={() => {
            setSelectedKind(undefined)
            setEditor(undefined)
            setError(undefined)
          }}
          title={t('plugins.back')}
          type="button"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="plugins-detail-title">
          <ConnectorIcon definition={selectedDefinition} size="large" />
          <div>
            <span>{t('plugins.title')} / {t(`plugins.categories.${connectorCategory(selectedDefinition.kind)}`)}</span>
            <h1>{translatedDefinitionName(selectedDefinition, t)}</h1>
          </div>
        </div>
      </header>

      <p className="plugins-detail-description">
        {t(`connectorSettings.kinds.${selectedDefinition.kind}.description`, {
          defaultValue: selectedDefinition.description,
        })}
      </p>

      <section className="plugins-detail-section" aria-labelledby="plugin-connections-title">
        <div className="plugins-detail-section-header">
          <div>
            <h2 id="plugin-connections-title">{t('plugins.connections')}</h2>
            <p>{t('plugins.connectionsDescription')}</p>
          </div>
          {editor === undefined && (
            <button
              className="plugins-outline-button"
              type="button"
              onClick={() => setEditor({ definition: selectedDefinition })}
            >
              <Plus size={14} aria-hidden="true" />
              {t('plugins.addConnection')}
            </button>
          )}
        </div>

        {selectedInstances.length === 0 ? (
          editor === undefined && (
            <div className="plugins-detail-empty">
              <Plug size={18} aria-hidden="true" />
              <span>{t('plugins.noConnections')}</span>
            </div>
          )
        ) : (
          <div className="plugins-instance-list">
            {selectedInstances.map((connector) => (
              <ConnectorInstanceRow
                busy={busyId === connector.id}
                connector={connector}
                key={connector.id}
                testResult={testResults[connector.id]}
                onEdit={() => openEdit(connector)}
                onRemove={() => void remove(connector)}
                onTest={() => void test(connector)}
                onToggle={() => void toggle(connector)}
              />
            ))}
          </div>
        )}

        {editor !== undefined && (
          <ConnectorEditor
            busy={busyId === (editor.instance?.id ?? 'new')}
            definition={editor.definition}
            instance={editor.instance}
            key={`${editor.definition.kind}:${editor.instance?.id ?? 'new'}`}
            onCancel={() => setEditor(undefined)}
            onSave={(input) => void saveEditor(input)}
          />
        )}
      </section>

      <section className="plugins-detail-section" aria-labelledby="plugin-capabilities-title">
        <div className="plugins-detail-section-header">
          <div>
            <h2 id="plugin-capabilities-title">{t('plugins.capabilities')}</h2>
            <p>{t('plugins.capabilitiesDescription')}</p>
          </div>
        </div>
        <ul className="plugins-capabilities">
          {selectedDefinition.capabilities.map((capability) => (
            <li key={capability.id}>
              <span className={`plugins-risk plugins-risk-${capability.risk}`}>
                {capability.risk === 'external-write' ? t('plugins.approvalRequired') : t('plugins.readOnly')}
              </span>
              <span>
                <strong>
                  {t(`connectorSettings.capabilities.${capabilityTranslationKey(capability.id)}`, {
                    defaultValue: capability.name,
                  })}
                </strong>
                <small>{capabilityDescription(capability, t)}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )

  return (
    <section className="plugins-page" aria-label={t('plugins.title')} data-testid="plugins-page">
      <div className="plugins-scroll">
        <div className="plugins-inner">
          {selectedDefinition === undefined ? catalog : detail}
        </div>
      </div>
    </section>
  )
}

function PluginSection({
  title,
  definitions,
  instances,
  onOpen,
}: {
  title: string
  definitions: ConnectorDefinition[]
  instances: ConnectorInstance[]
  onOpen(definition: ConnectorDefinition, startCreating?: boolean): void
}) {
  const { t } = useTranslation()
  return (
    <section className="plugins-section" aria-label={title}>
      <div className="plugins-section-header">
        <h2>{title}</h2>
      </div>
      <div className="plugins-list">
        {definitions.map((definition) => {
          const connectors = instances.filter((instance) => instance.kind === definition.kind)
          const status = aggregateStatus(connectors)
          return (
            <article className="plugin-row" data-plugin-kind={definition.kind} key={definition.kind}>
              <button
                className="plugin-row-main"
                onClick={() => onOpen(definition)}
                type="button"
              >
                <ConnectorIcon definition={definition} size="large" />
                <span className="plugin-row-copy">
                  <span className="plugin-row-title">
                    <strong>{translatedDefinitionName(definition, t)}</strong>
                    {connectors.length > 0 && status !== undefined && (
                      <span className={`connector-status connector-status-${status}`}>
                        {status === 'ready' && <CheckCircle2 size={11} aria-hidden="true" />}
                        {status === 'error' && <AlertCircle size={11} aria-hidden="true" />}
                        {t(`connectorSettings.status.${status}`)}
                      </span>
                    )}
                  </span>
                  <small>
                    {connectors.length > 0
                      ? t('plugins.connectionCount', { count: connectors.length })
                      : t(`connectorSettings.kinds.${definition.kind}.description`, {
                          defaultValue: definition.description,
                        })}
                  </small>
                </span>
              </button>
              <button
                aria-label={connectors.length > 0
                  ? t('plugins.manageNamed', { name: translatedDefinitionName(definition, t) })
                  : t('plugins.addNamed', { name: translatedDefinitionName(definition, t) })}
                className="plugin-row-action"
                onClick={() => onOpen(definition, connectors.length === 0)}
                type="button"
              >
                {connectors.length > 0 ? t('plugins.manage') : t('plugins.add')}
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function ConnectorInstanceRow({
  connector,
  busy,
  testResult,
  onEdit,
  onToggle,
  onTest,
  onRemove,
}: {
  connector: ConnectorInstance
  busy: boolean
  testResult?: ConnectorTestResult | undefined
  onEdit(): void
  onToggle(): void
  onTest(): void
  onRemove(): void
}) {
  const { t } = useTranslation()
  return (
    <article className={`plugin-instance-row plugin-instance-row-${connector.status}`} data-connector-id={connector.id}>
      <span className="plugin-instance-mark" aria-hidden="true">
        {connector.status === 'ready'
          ? <CheckCircle2 size={15} />
          : connector.status === 'error'
            ? <AlertCircle size={15} />
            : <Plug size={15} />}
      </span>
      <div className="plugin-instance-copy">
        <div className="plugin-instance-title">
          <strong>{connector.name}</strong>
          <span className={`connector-status connector-status-${connector.status}`}>
            {t(`connectorSettings.status.${connector.status}`)}
          </span>
        </div>
        <p>{connector.capabilities.map((capability) => capabilityName(capability, t)).join(' · ')}</p>
        {connector.lastError !== undefined && <small className="plugins-row-error">{connector.lastError}</small>}
        {testResult !== undefined && (
          <small className={testResult.ok ? 'plugins-row-success' : 'plugins-row-error'}>
            {testResult.message}
          </small>
        )}
      </div>
      <div className="plugin-instance-actions">
        <button className="plugins-outline-button compact" type="button" disabled={busy} onClick={onTest}>
          {busy ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          {t('connectorSettings.test')}
        </button>
        <button className="plugins-outline-button compact" type="button" disabled={busy} onClick={onEdit}>
          {t('connectorSettings.configure')}
        </button>
        <label className="plugin-switch" title={t('connectorSettings.enabled')}>
          <input type="checkbox" checked={connector.enabled} disabled={busy} onChange={onToggle} />
          <span />
        </label>
        <button
          className="plugin-icon-button danger"
          type="button"
          aria-label={t('connectorSettings.remove')}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

function ConnectorEditor({
  definition,
  instance,
  busy,
  onCancel,
  onSave,
}: {
  definition: ConnectorDefinition
  instance?: ConnectorInstance | undefined
  busy: boolean
  onCancel(): void
  onSave(input: { name: string; config: ConnectorConfig; credentials: Record<string, string> }): void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(instance?.name ?? translatedDefinitionName(definition, t))
  const [config, setConfig] = useState<ConnectorConfig>(() => initialConfigFor(definition, instance))
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const translated = t as (key: string, options?: { defaultValue?: string }) => string
  const setupNote = translated(`connectorSettings.kinds.${definition.kind}.note`, { defaultValue: '' })

  function setConfigValue(field: ConnectorSetupField, value: ConnectorConfigValue): void {
    setConfig((current) => ({ ...current, [field.key]: value }))
  }

  function setCredential(field: ConnectorSetupField, value: string): void {
    setCredentials((current) => ({ ...current, [field.key]: value }))
  }

  return (
    <form
      className="plugin-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, config, credentials })
      }}
    >
      <div className="plugin-editor-header">
        <div>
          <span>{instance === undefined ? t('connectorSettings.addTitle') : t('connectorSettings.editTitle')}</span>
          <h3>{translatedDefinitionName(definition, t)}</h3>
        </div>
      </div>

      {setupNote.length > 0 && (
        <div className="plugin-editor-note">
          <Info size={14} aria-hidden="true" />
          <p>{setupNote}</p>
        </div>
      )}

      {!definition.hideConnectionName && (
        <label>
          <span>{t('connectorSettings.name')}</span>
          <input value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} />
        </label>
      )}

      <div className="plugin-editor-grid">
        {definition.configFields.map((field) => (
          <label key={field.key} className={field.type === 'boolean' ? 'plugin-check-row' : undefined}>
            {field.type === 'boolean' ? (
              <>
                <input
                  type="checkbox"
                  checked={config[field.key] === true}
                  onChange={(event) => setConfigValue(field, event.target.checked)}
                />
                <span>{fieldLabel(field, t)}</span>
              </>
            ) : (
              <>
                <span>{fieldLabel(field, t)}{field.required ? ' *' : ''}</span>
                <input
                  type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
                  required={field.required}
                  value={String(config[field.key] ?? '')}
                  placeholder={translated(`connectorSettings.fieldPlaceholders.${field.key}`, { defaultValue: field.placeholder ?? '' })}
                  onChange={(event) => setConfigValue(
                    field,
                    field.type === 'number' ? Number(event.target.value) : event.target.value,
                  )}
                />
              </>
            )}
          </label>
        ))}
      </div>

      <div className="plugin-editor-credentials">
        <div>
          <h4>{t('connectorSettings.credentialsTitle')}</h4>
          <p>{instance === undefined ? t('connectorSettings.credentialsNew') : t('connectorSettings.credentialsExisting')}</p>
        </div>
        <div className="plugin-editor-grid">
          {definition.credentialFields.map((field) => (
            <label key={field.key}>
              <span>{fieldLabel(field, t)}{field.required && instance === undefined ? ' *' : ''}</span>
              <input
                type={field.type === 'password' ? 'password' : 'text'}
                required={field.required && instance === undefined}
                value={credentials[field.key] ?? ''}
                placeholder={instance === undefined
                  ? translated(`connectorSettings.fieldPlaceholders.${field.key}`, { defaultValue: field.placeholder ?? '' })
                  : t('connectorSettings.leaveBlank')}
                autoComplete="off"
                onChange={(event) => setCredential(field, event.target.value)}
              />
            </label>
          ))}
        </div>
        {definition.helpUrl !== undefined && (
          <a className="plugin-editor-help" href={definition.helpUrl} rel="noreferrer" target="_blank">
            {definition.kind === 'github' ? t('connectorSettings.githubTokenHelp') : t('connectorSettings.helpLink')}
          </a>
        )}
      </div>

      <div className="plugin-editor-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy && <LoaderCircle className="spin" size={14} aria-hidden="true" />}
          {t('common.save')}
        </button>
      </div>
    </form>
  )
}

function ConnectorIcon({
  definition,
  size = 'small',
}: {
  definition: ConnectorDefinition
  size?: 'small' | 'large'
}) {
  return (
    <span
      className={`plugin-artwork plugin-artwork-${definition.kind} plugin-artwork-${size}`}
      data-brand-icon={definition.kind}
      aria-hidden="true"
    >
      {definition.kind === 'github'
        ? <GithubBrandMark size={size} />
        : definition.kind === 'dingtalk'
          ? <DingTalkBrandMark size={size} />
          : definition.kind === 'wecomMail'
            ? <WeComBrandMark size={size} />
            : definition.icon === 'mail'
              ? <Mail size={size === 'large' ? 20 : 16} strokeWidth={1.9} />
              : <Plug size={size === 'large' ? 20 : 16} />}
    </span>
  )
}

/** GitHub provider mark, using the official brand silhouette. */
function GithubBrandMark({ size }: { size: 'small' | 'large' }) {
  return (
    <svg
      className={size === 'large' ? 'plugin-brand-svg large' : 'plugin-brand-svg'}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M12 1.95068C17.525 1.95068 22 6.42568 22 11.9507C21.9995 14.0459 21.3419 16.0883 20.1198 17.7902C18.8977 19.4922 17.1727 20.768 15.1875 21.4382C14.6875 21.5382 14.5 21.2257 14.5 20.9632C14.5 20.6257 14.5125 19.5507 14.5125 18.2132C14.5125 17.2757 14.2 16.6757 13.8375 16.3632C16.0625 16.1132 18.4 15.2632 18.4 11.4257C18.4 10.3257 18.0125 9.43818 17.375 8.73818C17.475 8.48818 17.825 7.46318 17.275 6.08818C17.275 6.08818 16.4375 5.81318 14.525 7.11318C13.725 6.88818 12.875 6.77568 12.025 6.77568C11.175 6.77568 10.325 6.88818 9.525 7.11318C7.6125 5.82568 6.775 6.08818 6.775 6.08818C6.225 7.46318 6.575 8.48818 6.675 8.73818C6.0375 9.43818 5.65 10.3382 5.65 11.4257C5.65 15.2507 7.975 16.1132 10.2 16.3632C9.9125 16.6132 9.65 17.0507 9.5625 17.7007C8.9875 17.9632 7.55 18.3882 6.65 16.8757C6.4625 16.5757 5.9 15.8382 5.1125 15.8507C4.275 15.8632 4.775 16.3257 5.125 16.5132C5.55 16.7507 6.0375 17.6382 6.15 17.9257C6.35 18.4882 7 19.5632 9.5125 19.1007C9.5125 19.9382 9.525 20.7257 9.525 20.9632C9.525 21.2257 9.3375 21.5257 8.8375 21.4382C6.8458 20.7752 5.11342 19.502 3.88611 17.799C2.65881 16.096 1.9989 14.0498 2 11.9507C2 6.42568 6.475 1.95068 12 1.95068Z"
      />
    </svg>
  )
}

/** Official WeCom mark, adapted from TDesign Icons (MIT). */
function WeComBrandMark({ size }: { size: 'small' | 'large' }) {
  return (
    <svg
      className={size === 'large' ? 'plugin-brand-svg large' : 'plugin-brand-svg'}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="m17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z"
      />
    </svg>
  )
}

/** Official DingTalk mark, adapted from Ant Design Icons (MIT). */
function DingTalkBrandMark({ size }: { size: 'small' | 'large' }) {
  return (
    <svg
      className={size === 'large' ? 'plugin-brand-svg large' : 'plugin-brand-svg'}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M573.7 252.5C422.5 197.4 201.3 96.7 201.3 96.7c-15.7-4.1-17.9 11.1-17.9 11.1c-5 61.1 33.6 160.5 53.6 182.8c19.9 22.3 319.1 113.7 319.1 113.7S326 357.9 270.5 341.9c-55.6-16-37.9 17.8-37.9 17.8c11.4 61.7 64.9 131.8 107.2 138.4c42.2 6.6 220.1 4 220.1 4s-35.5 4.1-93.2 11.9c-42.7 5.8-97 12.5-111.1 17.8c-33.1 12.5 24 62.6 24 62.6c84.7 76.8 129.7 50.5 129.7 50.5c33.3-10.7 61.4-18.5 85.2-24.2L565 743.1h84.6L603 928l205.3-271.9H700.8l22.3-38.7c.3.5.4.8.4.8S799.8 496.1 829 433.8l.6-1h-.1c5-10.8 8.6-19.7 10-25.8c17-71.3-114.5-99.4-265.8-154.5"
      />
    </svg>
  )
}

function connectorCategory(kind: string): ConnectorCategory {
  return kind === 'dingtalk' || kind === 'wecomMail' ? 'china' : 'integrations'
}

function aggregateStatus(instances: ConnectorInstance[]): ConnectorInstance['status'] | undefined {
  if (instances.some((instance) => instance.status === 'error')) return 'error'
  if (instances.some((instance) => instance.status === 'ready')) return 'ready'
  if (instances.some((instance) => instance.status === 'needs_setup')) return 'needs_setup'
  return instances.length > 0 ? 'disabled' : undefined
}

function translatedDefinitionName(
  definition: ConnectorDefinition,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.kinds.${definition.kind}.name`, { defaultValue: definition.name })
}

function fieldLabel(
  field: ConnectorSetupField,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.fields.${field.key}`, { defaultValue: field.label })
}

function capabilityTranslationKey(id: string): string {
  if (id === 'email.list') return 'emailList'
  if (id === 'email.search') return 'emailSearch'
  if (id === 'email.read') return 'emailRead'
  if (id === 'email.send') return 'emailSend'
  if (id === 'dingtalk.send') return 'dingtalkSend'
  if (id === 'wecomMail.search') return 'wecomMailSearch'
  if (id === 'wecomMail.get') return 'wecomMailGet'
  if (id === 'wecomMail.send') return 'wecomMailSend'
  if (id === 'github.searchRepositories') return 'githubSearchRepositories'
  if (id === 'github.searchIssues') return 'githubSearchIssues'
  if (id === 'github.listIssues') return 'githubListIssues'
  if (id === 'github.getIssue') return 'githubGetIssue'
  if (id === 'github.listPullRequests') return 'githubListPullRequests'
  if (id === 'github.getPullRequest') return 'githubGetPullRequest'
  if (id === 'github.createIssue') return 'githubCreateIssue'
  if (id === 'github.comment') return 'githubComment'
  return id
}

function capabilityDescription(
  capability: ConnectorCapabilityDefinition,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.capabilityDescriptions.${capabilityTranslationKey(capability.id)}`, {
    defaultValue: capability.description,
  })
}

function capabilityName(
  capability: ConnectorCapabilityDefinition,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.capabilities.${capabilityTranslationKey(capability.id)}`, {
    defaultValue: capability.name,
  })
}

function initialConfigFor(definition: ConnectorDefinition, instance?: ConnectorInstance): ConnectorConfig {
  const config: ConnectorConfig = { ...instance?.config }
  for (const field of definition.configFields) {
    if (config[field.key] === undefined && field.defaultValue !== undefined) config[field.key] = field.defaultValue
  }
  return config
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
