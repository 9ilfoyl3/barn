import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Mail,
  MessageCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import type {
  ConnectorConfig,
  ConnectorConfigValue,
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorSetupField,
  ConnectorTestResult,
} from '../shared/models'
import { TooltipButton } from './components/TooltipButton'
import './connector-settings.css'

interface ConnectorSettingsProps {
  onClose(): void
}

interface EditorState {
  definition: ConnectorDefinition
  instance?: ConnectorInstance | undefined
}

export function ConnectorSettings({ onClose }: ConnectorSettingsProps) {
  const { t } = useTranslation()
  const [definitions, setDefinitions] = useState<ConnectorDefinition[]>([])
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [editor, setEditor] = useState<EditorState>()
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({})

  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (editor === undefined) onClose()
        else setEditor(undefined)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editor, onClose])

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

  function openCreate(definition: ConnectorDefinition): void {
    setEditor({ definition })
  }

  function openEdit(connector: ConnectorInstance): void {
    const definition = definitions.find((entry) => entry.kind === connector.kind)
    if (definition === undefined) {
      setError(t('connectorSettings.unknownDefinition', { kind: connector.kind }))
      return
    }
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
    setNotice(undefined)
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
      setEditor(undefined)
      setNotice(t('connectorSettings.saved', { name: connector.name }))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel connector-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('connectorSettings.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span className="connector-settings-kicker">{t('connectorSettings.kicker')}</span>
            <h2>{t('connectorSettings.title')}</h2>
          </div>
          <TooltipButton className="icon-button" label={t('connectorSettings.close')} onClick={onClose}>
            <X size={18} />
          </TooltipButton>
        </header>

        <div className="connector-settings-body">
          <div className="connector-settings-intro-row">
            <p>{t('connectorSettings.intro')}</p>
            <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
              <RefreshCw size={14} />
              {t('connectorSettings.refresh')}
            </button>
          </div>

          {error !== undefined && <div className="settings-error" role="alert">{error}</div>}
          {notice !== undefined && <div className="settings-notice success" role="status">{notice}</div>}

          {loading ? (
            <div className="connector-settings-loading">
              <LoaderCircle className="spin" size={18} />
              <span>{t('common.loading')}</span>
            </div>
          ) : instances.length === 0 ? (
            <div className="connector-settings-empty">
              <span className="connector-settings-empty-icon"><Plus size={18} /></span>
              <div>
                <h3>{t('connectorSettings.emptyTitle')}</h3>
                <p>{t('connectorSettings.emptyDescription')}</p>
              </div>
            </div>
          ) : (
            <div className="connector-settings-list">
              {instances.map((connector) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  busy={busyId === connector.id}
                  testResult={testResults[connector.id]}
                  onEdit={() => openEdit(connector)}
                  onToggle={() => void toggle(connector)}
                  onTest={() => void test(connector)}
                  onRemove={() => void remove(connector)}
                />
              ))}
            </div>
          )}

          <section className="connector-settings-available" aria-labelledby="available-connectors-title">
            <div>
              <h3 id="available-connectors-title">{t('connectorSettings.availableTitle')}</h3>
              <p>{t('connectorSettings.availableDescription')}</p>
            </div>
            <div className="connector-definition-grid">
              {definitions.map((definition) => (
                <button
                  className="connector-definition-card"
                  key={definition.kind}
                  type="button"
                  onClick={() => openCreate(definition)}
                >
                  <ConnectorIcon kind={definition.icon} />
                  <span>
                    <strong>{t(`connectorSettings.kinds.${definition.kind}.name`, { defaultValue: definition.name })}</strong>
                    <small>{t(`connectorSettings.kinds.${definition.kind}.description`, { defaultValue: definition.description })}</small>
                  </span>
                  <Plus size={15} />
                </button>
              ))}
            </div>
          </section>

          {editor !== undefined && (
            <ConnectorEditor
              key={`${editor.definition.kind}:${editor.instance?.id ?? 'new'}`}
              definition={editor.definition}
              instance={editor.instance}
              busy={busyId === (editor.instance?.id ?? 'new')}
              onCancel={() => setEditor(undefined)}
              onSave={(input) => void saveEditor(input)}
            />
          )}
        </div>
      </section>
    </div>
  )
}

function ConnectorRow({
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
    <article className={`connector-row connector-row-${connector.status}`}>
      <ConnectorIcon kind={connector.kind === 'email' ? 'mail' : 'message-circle'} />
      <div className="connector-row-main">
        <div className="connector-row-title">
          <strong>{connector.name}</strong>
          <span className={`connector-status connector-status-${connector.status}`}>
            {connector.status === 'ready' && <CheckCircle2 size={12} />}
            {connector.status === 'error' && <AlertCircle size={12} />}
            {t(`connectorSettings.status.${connector.status}`)}
          </span>
        </div>
        <p>{connector.capabilities.map((capability) => capability.id).join(' · ')}</p>
        {connector.lastError !== undefined && <small className="connector-row-error">{connector.lastError}</small>}
        {testResult !== undefined && (
          <small className={testResult.ok ? 'connector-row-success' : 'connector-row-error'}>
            {testResult.message}
          </small>
        )}
      </div>
      <div className="connector-row-actions">
        <button className="secondary-button compact" type="button" disabled={busy} onClick={onTest}>
          {busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          {t('connectorSettings.test')}
        </button>
        <button className="secondary-button compact" type="button" disabled={busy} onClick={onEdit}>
          {t('connectorSettings.configure')}
        </button>
        <label className="connector-switch" title={t('connectorSettings.enabled')}>
          <input type="checkbox" checked={connector.enabled} disabled={busy} onChange={onToggle} />
          <span />
        </label>
        <button className="connector-icon-button danger" type="button" aria-label={t('connectorSettings.remove')} disabled={busy} onClick={onRemove}>
          <Trash2 size={14} />
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
  const initialConfig = initialConfigFor(definition, instance)
  const [name, setName] = useState(instance?.name ?? definition.name)
  const [config, setConfig] = useState<ConnectorConfig>(initialConfig)
  const [credentials, setCredentials] = useState<Record<string, string>>({})

  function setConfigValue(field: ConnectorSetupField, value: ConnectorConfigValue): void {
    setConfig((current) => ({ ...current, [field.key]: value }))
  }

  function setCredential(field: ConnectorSetupField, value: string): void {
    setCredentials((current) => ({ ...current, [field.key]: value }))
  }

  return (
    <form
      className="connector-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, config, credentials })
      }}
    >
      <div className="connector-editor-header">
        <div>
          <span>{instance === undefined ? t('connectorSettings.addTitle') : t('connectorSettings.editTitle')}</span>
          <h3>{t(`connectorSettings.kinds.${definition.kind}.name`, { defaultValue: definition.name })}</h3>
        </div>
        <button className="connector-icon-button" type="button" aria-label={t('common.cancel')} onClick={onCancel}>
          <X size={15} />
        </button>
      </div>

      <label>
        <span>{t('connectorSettings.name')}</span>
        <input value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} />
      </label>

      <div className="connector-editor-grid">
        {definition.configFields.map((field) => (
          <label key={field.key} className={field.type === 'boolean' ? 'connector-check-row' : undefined}>
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
                  placeholder={field.placeholder}
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

      <div className="connector-editor-section">
        <div>
          <h4>{t('connectorSettings.credentialsTitle')}</h4>
          <p>{instance === undefined ? t('connectorSettings.credentialsNew') : t('connectorSettings.credentialsExisting')}</p>
        </div>
        <div className="connector-editor-grid">
          {definition.credentialFields.map((field) => (
            <label key={field.key}>
              <span>{fieldLabel(field, t)}{field.required && instance === undefined ? ' *' : ''}</span>
              <input
                type={field.type === 'password' ? 'password' : 'text'}
                required={field.required && instance === undefined}
                value={credentials[field.key] ?? ''}
                placeholder={instance === undefined ? field.placeholder : t('connectorSettings.leaveBlank')}
                autoComplete="off"
                onChange={(event) => setCredential(field, event.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="connector-editor-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy && <LoaderCircle className="spin" size={14} />}
          {t('common.save')}
        </button>
      </div>
    </form>
  )
}

function ConnectorIcon({ kind }: { kind: 'mail' | 'message-circle' }) {
  return (
    <span className="connector-icon">
      {kind === 'mail' ? <Mail size={17} /> : <MessageCircle size={17} />}
    </span>
  )
}

function initialConfigFor(definition: ConnectorDefinition, instance?: ConnectorInstance): ConnectorConfig {
  const config: ConnectorConfig = { ...instance?.config }
  for (const field of definition.configFields) {
    if (config[field.key] === undefined && field.defaultValue !== undefined) config[field.key] = field.defaultValue
  }
  return config
}

function fieldLabel(
  field: ConnectorSetupField,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.fields.${field.key}`, { defaultValue: field.label })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
