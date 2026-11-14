import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, FolderSearch, Plus, Trash2, X } from 'lucide-react'
import type { AutomationSettings, LocalSource } from '../shared/models'
import { TooltipButton } from './components/TooltipButton'
import './source-settings.css'

type AddMode = 'file-watch' | 'schedule'

export function SourceSettings({ onClose }: { onClose(): void }) {
  const { t } = useTranslation()
  const [sources, setSources] = useState<LocalSource[]>([])
  const [automation, setAutomation] = useState<AutomationSettings>()
  const [notice, setNotice] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [mode, setMode] = useState<AddMode>()
  const [name, setName] = useState('')
  const [watchPath, setWatchPath] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [maxDepth, setMaxDepth] = useState(2)
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [scheduleTitle, setScheduleTitle] = useState('')
  const [schedulePrompt, setSchedulePrompt] = useState('')

  useEffect(() => {
    void reload()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  async function reload(): Promise<void> {
    try {
      const [nextSources, settings] = await Promise.all([
        window.barn.localSources.list(),
        window.barn.localSources.getAutomationSettings(),
      ])
      setSources(nextSources)
      setAutomation(settings)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function chooseFolder(): Promise<void> {
    try {
      const path = await window.barn.localSources.chooseDirectory()
      if (path !== undefined) {
        setWatchPath(path)
        if (name.trim().length === 0) setName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? t('sourceSettings.watchedFolder'))
      }
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function createSource(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      if (mode === 'file-watch') {
        await window.barn.localSources.create({
          name,
          config: { kind: 'file-watch', path: watchPath, recursive, maxDepth },
        })
      } else if (mode === 'schedule') {
        await window.barn.localSources.create({
          name,
          config: { kind: 'schedule', intervalMinutes, title: scheduleTitle, prompt: schedulePrompt },
        })
      }
      resetForm()
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function toggle(source: LocalSource): Promise<void> {
    setBusy(true)
    try {
      await window.barn.localSources.setEnabled(source.id, !source.enabled)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function remove(source: LocalSource): Promise<void> {
    setBusy(true)
    try {
      await window.barn.localSources.remove(source.id)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function saveAutomation(): Promise<void> {
    if (automation === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      setAutomation(await window.barn.localSources.setAutomationSettings(automation))
      setNotice(t('sourceSettings.saved'))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function checkNow(): Promise<void> {
    setBusy(true)
    try {
      await window.barn.localSources.pollNow()
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  function resetForm(): void {
    setMode(undefined)
    setName('')
    setWatchPath('')
    setRecursive(true)
    setMaxDepth(2)
    setIntervalMinutes(60)
    setScheduleTitle('')
    setSchedulePrompt('')
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel source-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('sourceSettings.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span>{t('sourceSettings.kicker')}</span>
            <h2>{t('sourceSettings.title')}</h2>
          </div>
          <TooltipButton className="icon-button" label={t('sourceSettings.close')} onClick={onClose}>
            <X size={18} />
          </TooltipButton>
        </header>

        <div className="source-settings-body">
          <p className="source-settings-intro">{t('sourceSettings.intro')}</p>
          {error !== undefined && <div className="settings-error" role="alert">{error}</div>}
          {notice !== undefined && <div className="settings-notice success" role="status">{notice}</div>}

          {automation !== undefined && (
            <section className="automation-settings" aria-labelledby="automation-settings-title">
              <div>
                <h3 id="automation-settings-title">{t('sourceSettings.automationTitle')}</h3>
                <p>{t('sourceSettings.automationDescription')}</p>
              </div>
              <div className="source-form-grid">
                <label>
                  <span>{t('sourceSettings.mode')}</span>
                  <select value={automation.mode} onChange={(event) => {
                    setAutomation({ ...automation, mode: event.target.value as AutomationSettings['mode'] })
                    setNotice(undefined)
                  }}>
                    <option value="observe">{t('sourceSettings.observe')}</option>
                    <option value="active">{t('sourceSettings.active')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('sourceSettings.pendingLimit')}</span>
                  <input type="number" min={1} max={200} value={automation.maxPendingSuggestions} onChange={(event) => {
                    setAutomation({ ...automation, maxPendingSuggestions: Number(event.target.value) })
                    setNotice(undefined)
                  }} />
                </label>
                <label>
                  <span>{t('sourceSettings.cooldown')}</span>
                  <input type="number" min={0} max={10080} value={automation.suggestionCooldownMinutes} onChange={(event) => {
                    setAutomation({ ...automation, suggestionCooldownMinutes: Number(event.target.value) })
                    setNotice(undefined)
                  }} />
                </label>
              </div>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void saveAutomation()}>
                {t('common.save')}
              </button>
            </section>
          )}

          {loading ? (
            <p className="source-settings-muted">{t('sourceSettings.loading')}</p>
          ) : sources.length === 0 ? (
            <p className="source-settings-muted">{t('sourceSettings.empty')}</p>
          ) : (
            <div className="source-settings-list">
              {sources.map((source) => (
                <article className="source-settings-row" key={source.id}>
                  <div className="source-settings-copy">
                    <h3>{source.name}</h3>
                    <p>
                      {source.config.kind === 'file-watch'
                        ? t('sourceSettings.fileDescription', { depth: source.config.maxDepth })
                        : t('sourceSettings.scheduleDescription', { count: source.config.intervalMinutes })}
                    </p>
                    <small>{source.config.kind === 'file-watch' ? source.config.path : source.config.title}</small>
                    {source.lastError !== undefined && <span className="source-settings-error">{source.lastError}</span>}
                  </div>
                  <div className="source-settings-actions">
                    <label className="source-settings-switch">
                      <input type="checkbox" checked={source.enabled} disabled={busy} onChange={() => void toggle(source)} />
                      <span>{source.enabled ? t('sourceSettings.enabled') : t('sourceSettings.paused')}</span>
                    </label>
                    <button className="source-icon-button" type="button" aria-label={t('sourceSettings.remove', { name: source.name })} disabled={busy} onClick={() => void remove(source)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="source-settings-footer-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void checkNow()}>
              {t('sourceSettings.checkNow')}
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setMode('file-watch')}>
              <FolderSearch size={15} />
              {t('sourceSettings.watchFolder')}
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setMode('schedule')}>
              <CalendarClock size={15} />
              {t('sourceSettings.addSchedule')}
            </button>
          </div>

          {mode !== undefined && (
            <form className="source-settings-form" onSubmit={(event) => { event.preventDefault(); void createSource() }}>
              <h3>{mode === 'file-watch' ? t('sourceSettings.newWatchTitle') : t('sourceSettings.newScheduleTitle')}</h3>
              <label>
                <span>{t('sourceSettings.name')}</span>
                <input value={name} required onChange={(event) => setName(event.target.value)} />
              </label>
              {mode === 'file-watch' ? (
                <>
                  <label>
                    <span>{t('sourceSettings.folder')}</span>
                    <div className="source-path-row">
                      <input value={watchPath} required readOnly placeholder={t('sourceSettings.noFolder')} />
                      <button className="secondary-button" type="button" onClick={() => void chooseFolder()}>{t('sourceSettings.chooseFolder')}</button>
                    </div>
                  </label>
                  <div className="source-form-grid">
                    <label className="source-check-row">
                      <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
                      <span>{t('sourceSettings.includeSubfolders')}</span>
                    </label>
                    <label>
                      <span>{t('sourceSettings.depth')}</span>
                      <select value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))}>
                        {[0, 1, 2, 3, 4].map((depth) => <option value={depth} key={depth}>{depth}</option>)}
                      </select>
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    <span>{t('sourceSettings.taskTitle')}</span>
                    <input value={scheduleTitle} required onChange={(event) => setScheduleTitle(event.target.value)} />
                  </label>
                  <label>
                    <span>{t('sourceSettings.instructions')}</span>
                    <textarea rows={4} value={schedulePrompt} required onChange={(event) => setSchedulePrompt(event.target.value)} />
                  </label>
                  <label>
                    <span>{t('sourceSettings.intervalMinutes')}</span>
                    <input type="number" min={1} max={10080} value={intervalMinutes} required onChange={(event) => setIntervalMinutes(Number(event.target.value))} />
                  </label>
                </>
              )}
              <div className="source-form-actions">
                <button className="secondary-button" type="button" onClick={resetForm}>{t('common.cancel')}</button>
                <button className="primary-button" type="submit" disabled={busy || (mode === 'file-watch' ? watchPath.length === 0 : scheduleTitle.trim().length === 0)}>
                  <Plus size={15} />
                  {t('sourceSettings.addSource')}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
