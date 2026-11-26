import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, FolderSearch, Plus, Trash2, X } from 'lucide-react'
import type { AutomationSettings, LocalSource } from '../shared/models'
import { TooltipButton } from './components/TooltipButton'
import { Input } from './components/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/beui/components/motion/select'
import { notifySuccess, useErrorToast } from './notifications'
import './source-settings.css'
import { Button } from './components/Button'

type AddMode = 'file-watch' | 'schedule'

export function SourceSettings({ onClose }: { onClose(): void }) {
  const { t } = useTranslation()
  const [sources, setSources] = useState<LocalSource[]>([])
  const [automation, setAutomation] = useState<AutomationSettings>()
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<'automation' | 'check' | 'source' | 'create'>()
  const busy = busyAction !== undefined
  const [error, setError] = useState<string>()
  const [mode, setMode] = useState<AddMode>()
  const [name, setName] = useState('')
  const [watchPath, setWatchPath] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [maxDepth, setMaxDepth] = useState(2)
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [scheduleTitle, setScheduleTitle] = useState('')
  const [schedulePrompt, setSchedulePrompt] = useState('')

  useErrorToast(error)

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
    setBusyAction('create')
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
      setBusyAction(undefined)
    }
  }

  async function toggle(source: LocalSource): Promise<void> {
    setBusyAction('source')
    try {
      await window.barn.localSources.setEnabled(source.id, !source.enabled)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyAction(undefined)
    }
  }

  async function remove(source: LocalSource): Promise<void> {
    setBusyAction('source')
    try {
      await window.barn.localSources.remove(source.id)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyAction(undefined)
    }
  }

  async function saveAutomation(): Promise<void> {
    if (automation === undefined) return
    setBusyAction('automation')
    setError(undefined)
    try {
      setAutomation(await window.barn.localSources.setAutomationSettings(automation))
      notifySuccess(t('sourceSettings.saved'))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyAction(undefined)
    }
  }

  async function checkNow(): Promise<void> {
    setBusyAction('check')
    try {
      await window.barn.localSources.pollNow()
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyAction(undefined)
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
            <span className="source-settings-kicker">{t('sourceSettings.kicker')}</span>
            <h2>{t('sourceSettings.title')}</h2>
          </div>
          <TooltipButton className="icon-button" label={t('sourceSettings.close')} onClick={onClose}>
            <X size={18} />
          </TooltipButton>
        </header>

        <div className="source-settings-body">
          <p className="source-settings-intro">{t('sourceSettings.intro')}</p>

          {automation !== undefined && (
            <section className="automation-settings" aria-labelledby="automation-settings-title">
              <div>
                <h3 id="automation-settings-title">{t('sourceSettings.automationTitle')}</h3>
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
                  <Input type="number" min={1} max={200} value={automation.maxPendingSuggestions} onChange={(event) => {
                    setAutomation({ ...automation, maxPendingSuggestions: Number(event.target.value) })
                  }} density="compact" />
                </label>
                <label>
                  <span>{t('sourceSettings.cooldown')}</span>
                  <Input type="number" min={0} max={10080} value={automation.suggestionCooldownMinutes} onChange={(event) => {
                    setAutomation({ ...automation, suggestionCooldownMinutes: Number(event.target.value) })
                  }} density="compact" />
                </label>
              </div>
              <Button
                className="secondary-button"
                type="button"
                disabled={busy}
                state={busyAction === 'automation' ? 'loading' : 'idle'}
                loadingText={t('common.saving')}
                onClick={() => void saveAutomation()}
              >
                {t('common.save')}
              </Button>
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
                    <Button className="source-icon-button" type="button" aria-label={t('sourceSettings.remove', { name: source.name })} disabled={busy} onClick={() => void remove(source)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="source-settings-footer-actions">
            <Button
              className="secondary-button"
              type="button"
              disabled={busy}
              state={busyAction === 'check' ? 'loading' : 'idle'}
              loadingText={t('sourceSettings.checkNow')}
              onClick={() => void checkNow()}
            >
              {t('sourceSettings.checkNow')}
            </Button>
            <Button className="secondary-button" type="button" disabled={busy} onClick={() => setMode('file-watch')}>
              <FolderSearch size={15} />
              {t('sourceSettings.watchFolder')}
            </Button>
            <Button className="secondary-button" type="button" disabled={busy} onClick={() => setMode('schedule')}>
              <CalendarClock size={15} />
              {t('sourceSettings.addSchedule')}
            </Button>
          </div>

          {mode !== undefined && (
            <form className="source-settings-form" onSubmit={(event) => { event.preventDefault(); void createSource() }}>
              <h3>{mode === 'file-watch' ? t('sourceSettings.newWatchTitle') : t('sourceSettings.newScheduleTitle')}</h3>
              <label>
                <span>{t('sourceSettings.name')}</span>
                <Input value={name} required onChange={(event) => setName(event.target.value)} density="compact" />
              </label>
              {mode === 'file-watch' ? (
                <>
                  <label>
                    <span>{t('sourceSettings.folder')}</span>
                    <div className="source-path-row">
                      <Input value={watchPath} required readOnly placeholder={t('sourceSettings.noFolder')} density="compact" />
                      <Button className="secondary-button" type="button" onClick={() => void chooseFolder()}>{t('sourceSettings.chooseFolder')}</Button>
                    </div>
                  </label>
                  <div className="source-form-grid">
                    <label className="source-check-row">
                      <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
                      <span>{t('sourceSettings.includeSubfolders')}</span>
                    </label>
                    <label>
                      <span>{t('sourceSettings.depth')}</span>
                      <Select value={String(maxDepth)} className="source-select-root" onValueChange={(value) => setMaxDepth(Number(value))}>
                        <SelectTrigger className="source-select-trigger" ariaLabel={t('sourceSettings.depth')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[0, 1, 2, 3, 4].map((depth) => (
                            <SelectItem value={String(depth)} key={depth}>{depth}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    <span>{t('sourceSettings.taskTitle')}</span>
                    <Input value={scheduleTitle} required onChange={(event) => setScheduleTitle(event.target.value)} density="compact" />
                  </label>
                  <label>
                    <span>{t('sourceSettings.instructions')}</span>
                    <textarea rows={4} value={schedulePrompt} required onChange={(event) => setSchedulePrompt(event.target.value)} />
                  </label>
                  <label>
                    <span>{t('sourceSettings.intervalMinutes')}</span>
                    <Input type="number" min={1} max={10080} value={intervalMinutes} required onChange={(event) => setIntervalMinutes(Number(event.target.value))} density="compact" />
                  </label>
                </>
              )}
              <div className="source-form-actions">
                <Button className="secondary-button" type="button" onClick={resetForm}>{t('common.cancel')}</Button>
                <Button
                  className="primary-button"
                  type="submit"
                  disabled={busy || (mode === 'file-watch' ? watchPath.length === 0 : scheduleTitle.trim().length === 0)}
                  state={busyAction === 'create' ? 'loading' : 'idle'}
                  loadingText={t('common.saving')}
                >
                  <Plus size={15} />
                  {t('sourceSettings.addSource')}
                </Button>
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
