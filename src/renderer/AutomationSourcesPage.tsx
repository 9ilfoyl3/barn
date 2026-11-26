import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BellRing, Github, MessageCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  AutomationSettings,
  ConnectorInstance,
  ConnectorSource,
  ConnectorSourceEvent,
  CreateConnectorSourceInput,
  LocalSource,
} from '../shared/models'
import { Button } from './components/Button'
import { Input } from './components/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/beui/components/motion/select'
import { SourceSettings } from './SourceSettings'
import { notifySuccess, useErrorToast } from './notifications'
import './source-settings.css'
import './automation-sources.css'

type SourceKind = 'github' | 'dingtalk'
type BusyAction = 'settings' | 'check' | 'create' | 'source'

export function AutomationSourcesPage() {
  const { t } = useTranslation()
  const [connectors, setConnectors] = useState<ConnectorInstance[]>([])
  const [sources, setSources] = useState<ConnectorSource[]>([])
  const [localSources, setLocalSources] = useState<LocalSource[]>([])
  const [events, setEvents] = useState<ConnectorSourceEvent[]>([])
  const [automation, setAutomation] = useState<AutomationSettings>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyAction>()
  const [error, setError] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false)
  const [kind, setKind] = useState<SourceKind>('github')
  const [name, setName] = useState('')
  const [connectorId, setConnectorId] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [conversationId, setConversationId] = useState('')
  const [dwUserId, setDwUserId] = useState('')
  const [keywords, setKeywords] = useState('')
  const [pollSeconds, setPollSeconds] = useState(60)

  useErrorToast(error)

  const eligibleConnectors = useMemo(
    () => connectors.filter((connector) => connector.kind === kind && connector.enabled && connector.status === 'ready'),
    [connectors, kind],
  )

  useEffect(() => {
    void reload()
  }, [])

  async function reload(): Promise<void> {
    try {
      const [nextConnectors, nextSources, nextLocal, nextEvents, nextAutomation] = await Promise.all([
        window.barn.connectors.list(),
        window.barn.connectorSources.list(),
        window.barn.localSources.list(),
        window.barn.connectorSources.listEvents(undefined, 20),
        window.barn.localSources.getAutomationSettings(),
      ])
      setConnectors(nextConnectors)
      setSources(nextSources)
      setLocalSources(nextLocal)
      setEvents(nextEvents)
      setAutomation(nextAutomation)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function saveAutomation(): Promise<void> {
    if (automation === undefined) return
    setBusy('settings')
    setError(undefined)
    try {
      setAutomation(await window.barn.localSources.setAutomationSettings(automation))
      notifySuccess(t('sourceSettings.saved'))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function checkNow(): Promise<void> {
    setBusy('check')
    setError(undefined)
    try {
      await Promise.all([
        window.barn.connectorSources.pollNow(),
        window.barn.localSources.pollNow(),
      ])
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function createSource(): Promise<void> {
    const connector = eligibleConnectors.find((item) => item.id === connectorId)
    if (connector === undefined) {
      setError(t('automationSources.chooseConnector'))
      return
    }
    const input: CreateConnectorSourceInput = kind === 'github'
      ? {
          name: name.trim() || `${connector.name} · ${owner}/${repo}`,
          config: {
            kind: 'github',
            connectorId,
            owner: owner.trim(),
            repo: repo.trim(),
            events: ['issues', 'pullRequests'],
            pollSeconds,
          },
        }
      : {
          name: name.trim() || `DingTalk · ${conversationId.trim() || dwUserId.trim()}`,
          config: {
            kind: 'dingtalk',
            connectorId,
            ...(conversationId.trim().length === 0 ? { userId: dwUserId.trim() } : { conversationId: conversationId.trim() }),
            keywords: keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean),
            events: ['messages', 'todos'],
            pollSeconds,
          },
        }
    setBusy('create')
    setError(undefined)
    try {
      await window.barn.connectorSources.create(input)
      setFormOpen(false)
      resetForm()
      await reload()
      notifySuccess(t('automationSources.created'))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function toggle(source: ConnectorSource): Promise<void> {
    setBusy('source')
    setError(undefined)
    try {
      await window.barn.connectorSources.setEnabled(source.id, !source.enabled)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function remove(source: ConnectorSource): Promise<void> {
    if (!window.confirm(t('automationSources.removeConfirm', { name: source.name }))) return
    setBusy('source')
    setError(undefined)
    try {
      await window.barn.connectorSources.remove(source.id)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  function resetForm(): void {
    setKind('github')
    setName('')
    setConnectorId('')
    setOwner('')
    setRepo('')
    setConversationId('')
    setDwUserId('')
    setKeywords('')
    setPollSeconds(60)
  }

  const connectorSourceCount = sources.length
  const canCreate = connectorId.length > 0 && (
    kind === 'github' ? owner.trim().length > 0 && repo.trim().length > 0 : conversationId.trim().length > 0 || dwUserId.trim().length > 0
  )

  return (
    <div className="automation-sources-page">
      <header className="automation-sources-heading">
        <div>
          <span className="source-settings-kicker">{t('sourceSettings.kicker')}</span>
          <h1>{t('automationSources.title')}</h1>
          <p>{t('automationSources.intro')}</p>
        </div>
        <div className="automation-sources-heading-actions">
          <Button className="secondary-button" type="button" disabled={busy !== undefined} onClick={() => setLocalSettingsOpen(true)}>
            {t('automationSources.manageLocal')}
            {localSources.length > 0 && <span className="automation-count">{localSources.length}</span>}
          </Button>
          <Button
            className="secondary-button"
            type="button"
            disabled={busy !== undefined}
            state={busy === 'check' ? 'loading' : 'idle'}
            loadingText={t('sourceSettings.checkNow')}
            onClick={() => void checkNow()}
          >
            <RefreshCw size={15} />
            {t('sourceSettings.checkNow')}
          </Button>
          <Button className="primary-button" type="button" disabled={busy !== undefined} onClick={() => setFormOpen(true)}>
            <Plus size={15} />
            {t('automationSources.addSource')}
          </Button>
        </div>
      </header>

      {automation !== undefined && (
        <section className="automation-settings automation-source-settings" aria-labelledby="connector-automation-title">
          <div>
            <h3 id="connector-automation-title">{t('sourceSettings.automationTitle')}</h3>
            <p>{t('sourceSettings.automationDescription')}</p>
          </div>
          <div className="source-form-grid">
            <label>
              <span>{t('sourceSettings.mode')}</span>
              <Select
                value={automation.mode}
                className="source-select-root"
                onValueChange={(value) => setAutomation({ ...automation, mode: value as AutomationSettings['mode'] })}
              >
                <SelectTrigger className="source-select-trigger" ariaLabel={t('sourceSettings.mode')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="observe">{t('sourceSettings.observe')}</SelectItem>
                  <SelectItem value="active">{t('sourceSettings.active')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label>
              <span>{t('sourceSettings.pendingLimit')}</span>
              <Input
                type="number"
                min={1}
                max={200}
                value={automation.maxPendingSuggestions}
                onChange={(event) => setAutomation({ ...automation, maxPendingSuggestions: Number(event.target.value) })}
                density="compact"
              />
            </label>
            <label>
              <span>{t('sourceSettings.cooldown')}</span>
              <Input
                type="number"
                min={0}
                max={10080}
                value={automation.suggestionCooldownMinutes}
                onChange={(event) => setAutomation({ ...automation, suggestionCooldownMinutes: Number(event.target.value) })}
                density="compact"
              />
            </label>
          </div>
          <Button
            className="secondary-button"
            type="button"
            disabled={busy !== undefined}
            state={busy === 'settings' ? 'loading' : 'idle'}
            loadingText={t('common.saving')}
            onClick={() => void saveAutomation()}
          >
            {t('common.save')}
          </Button>
        </section>
      )}

      <section className="automation-source-section" aria-labelledby="connected-app-sources-title">
        <div className="automation-source-section-heading">
          <div>
            <h2 id="connected-app-sources-title">{t('automationSources.connectedTitle')}</h2>
            <p>{t('automationSources.connectedDescription')}</p>
          </div>
          <span className="automation-count">{connectorSourceCount}</span>
        </div>

        {loading ? (
          <p className="source-settings-muted">{t('sourceSettings.loading')}</p>
        ) : sources.length === 0 ? (
          <div className="automation-source-empty">
            <BellRing size={20} aria-hidden="true" />
            <div>
              <strong>{t('automationSources.emptyTitle')}</strong>
              <p>{t('automationSources.emptyDescription')}</p>
            </div>
          </div>
        ) : (
          <div className="automation-source-list">
            {sources.map((source) => {
              const sourceEvents = events.filter((event) => event.sourceId === source.id).slice(0, 4)
              const connector = connectors.find((item) => item.id === source.config.connectorId)
              return (
                <article className="automation-source-card" data-source-kind={source.config.kind} key={source.id}>
                  <div className="automation-source-card-heading">
                    <div className="automation-source-icon" aria-hidden="true">
                      {source.config.kind === 'github' ? <Github size={18} /> : <MessageCircle size={18} />}
                    </div>
                    <div className="automation-source-title">
                      <div>
                        <h3>{source.name}</h3>
                        <span className="automation-source-kind">{connector?.name ?? source.config.kind}</span>
                      </div>
                      <p>{sourceDescription(source)}</p>
                    </div>
                    <label className="source-settings-switch">
                      <input type="checkbox" checked={source.enabled} disabled={busy !== undefined} onChange={() => void toggle(source)} />
                      <span>{source.enabled ? t('sourceSettings.enabled') : t('sourceSettings.paused')}</span>
                    </label>
                    <Button className="source-icon-button" type="button" aria-label={t('sourceSettings.remove', { name: source.name })} disabled={busy !== undefined} onClick={() => void remove(source)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>

                  <div className="automation-source-meta">
                    <span>{t('automationSources.lastChecked', { time: source.lastCheckedAt === undefined ? t('automationSources.never') : formatTime(source.lastCheckedAt) })}</span>
                    <span>{t('automationSources.eventCount', { count: sourceEvents.length })}</span>
                  </div>

                  {source.lastError !== undefined && <span className="source-settings-error">{source.lastError}</span>}

                  {sourceEvents.length > 0 && (
                    <ol className="automation-event-list">
                      {sourceEvents.map((event) => (
                        <li key={event.id}>
                          <span className={`automation-event-dot automation-event-dot-${event.kind}`} aria-hidden="true" />
                          <div>
                            <strong>{event.title}</strong>
                            <small>{event.taskId === undefined ? t('automationSources.baselineEvent') : t('automationSources.taskCreated')}</small>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {formOpen && (
        <div className="automation-source-form-shell">
          <form className="source-settings-form automation-source-form" onSubmit={(event) => { event.preventDefault(); void createSource() }}>
            <div className="automation-source-form-heading">
              <div>
                <h2>{t('automationSources.newTitle')}</h2>
                <p>{t('automationSources.newDescription')}</p>
              </div>
            </div>

            <div className="source-form-grid automation-kind-grid">
              <label>
                <span>{t('automationSources.kind')}</span>
                <select aria-label={t('automationSources.kind')} value={kind} onChange={(event) => {
                  setKind(event.target.value as SourceKind)
                  setConnectorId('')
                }}>
                  <option value="github">GitHub</option>
                  <option value="dingtalk">DingTalk</option>
                </select>
              </label>
              <label>
                <span>{t('automationSources.connector')}</span>
                <select aria-label={t('automationSources.connector')} value={connectorId} onChange={(event) => setConnectorId(event.target.value)}>
                  <option value="">{t('automationSources.chooseConnector')}</option>
                  {eligibleConnectors.map((connector) => (
                    <option value={connector.id} key={connector.id}>{connector.name}</option>
                  ))}
                </select>
              </label>
            </div>

            {eligibleConnectors.length === 0 && (
              <p className="automation-source-inline-note">{t('automationSources.noConnector', { kind })}</p>
            )}

            <label>
              <span>{t('sourceSettings.name')}</span>
              <Input aria-label={t('sourceSettings.name')} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('automationSources.namePlaceholder')} density="compact" />
            </label>

            {kind === 'github' ? (
              <div className="source-form-grid">
                <label>
                  <span>{t('automationSources.repositoryOwner')}</span>
                  <Input aria-label={t('automationSources.repositoryOwner')} value={owner} required onChange={(event) => setOwner(event.target.value)} placeholder="acme" density="compact" />
                </label>
                <label>
                  <span>{t('automationSources.repositoryName')}</span>
                  <Input aria-label={t('automationSources.repositoryName')} value={repo} required onChange={(event) => setRepo(event.target.value)} placeholder="payments" density="compact" />
                </label>
              </div>
            ) : (
              <>
                <div className="source-form-grid">
                  <label>
                    <span>{t('automationSources.conversationId')}</span>
                    <Input aria-label={t('automationSources.conversationId')} value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="cid_xxx" density="compact" />
                  </label>
                  <label>
                    <span>{t('automationSources.userId')}</span>
                    <Input aria-label={t('automationSources.userId')} value={dwUserId} onChange={(event) => setDwUserId(event.target.value)} placeholder={t('automationSources.orUserId')} density="compact" />
                  </label>
                </div>
                <label>
                  <span>{t('automationSources.keywords')}</span>
                  <Input aria-label={t('automationSources.keywords')} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={t('automationSources.keywordsPlaceholder')} density="compact" />
                </label>
              </>
            )}

            <label>
              <span>{t('automationSources.pollSeconds')}</span>
              <Input aria-label={t('automationSources.pollSeconds')} type="number" min={30} max={3600} value={pollSeconds} onChange={(event) => setPollSeconds(Number(event.target.value))} density="compact" />
            </label>

            <div className="source-form-actions">
              <Button className="secondary-button" type="button" onClick={() => setFormOpen(false)}>{t('common.cancel')}</Button>
              <Button
                className="primary-button"
                type="submit"
                disabled={busy !== undefined || !canCreate}
                state={busy === 'create' ? 'loading' : 'idle'}
                loadingText={t('common.saving')}
              >
                <Plus size={15} />
                {t('automationSources.addSource')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {localSettingsOpen && <SourceSettings onClose={() => { setLocalSettingsOpen(false); void reload() }} />}
    </div>
  )
}

function sourceDescription(source: ConnectorSource): string {
  if (source.config.kind === 'github') {
    return `${source.config.owner}/${source.config.repo} · issues + pull requests`
  }
  const target = source.config.conversationId === undefined ? source.config.userId : source.config.conversationId
  return `${target ?? 'DingTalk'}${source.config.keywords.length === 0 ? '' : ` · ${source.config.keywords.join(', ')}`}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
