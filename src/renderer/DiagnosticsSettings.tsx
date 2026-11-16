import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, X } from 'lucide-react'
import type { DiagnosticsSnapshot } from '../shared/models'
import { TooltipButton } from './components/TooltipButton'
import { MemorySettingsPanel } from './MemorySettingsPanel'
import './diagnostics-settings.css'

export function DiagnosticsSettings({ onClose }: { onClose(): void }) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>()
  const [retention, setRetention] = useState(365)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    void window.barn.diagnostics.get().then((value) => {
      setSnapshot(value)
      setRetention(value.retentionDays)
    }).catch((reason: unknown) => setError(errorMessage(reason)))
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  async function saveRetention(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      await window.barn.diagnostics.setRetentionDays(retention)
      setSnapshot(await window.barn.diagnostics.get())
      setNotice(t('diagnostics.retentionSaved'))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function runMaintenance(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.barn.diagnostics.runMaintenance()
      setSnapshot(await window.barn.diagnostics.get())
      setNotice(t('diagnostics.cleanupComplete', {
        actionEvents: result.actionEvents,
        sourceEvents: result.sourceEvents,
        approvals: result.approvals,
      }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel diagnostics-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('diagnostics.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span className="diagnostics-kicker">{t('diagnostics.kicker')}</span>
            <h2>{t('diagnostics.title')}</h2>
          </div>
          <TooltipButton className="icon-button" label={t('diagnostics.close')} onClick={onClose}>
            <X size={18} />
          </TooltipButton>
        </header>
        <div className="diagnostics-body">
          {error !== undefined && <div className="settings-error" role="alert">{error}</div>}
          {notice !== undefined && <div className="settings-notice success" role="status">{notice}</div>}
          {snapshot === undefined ? (
            <p className="diagnostics-muted">{t('common.loading')}</p>
          ) : (
            <>
              <div className="diagnostics-summary">
                <Activity size={18} />
                <div>
                  <h3>{t('diagnostics.version', { version: snapshot.appVersion })}</h3>
                  <p>{t('diagnostics.runtime', {
                    platform: snapshot.platform,
                    arch: snapshot.arch,
                    electron: snapshot.electronVersion,
                  })}</p>
                </div>
              </div>

              <dl className="diagnostics-grid">
                <div><dt>{t('diagnostics.schema')}</dt><dd>{snapshot.schemaVersion}</dd></div>
                <div><dt>{t('diagnostics.sessions')}</dt><dd>{snapshot.counts.sessions}</dd></div>
                <div><dt>{t('diagnostics.tasks')}</dt><dd>{snapshot.counts.tasks}</dd></div>
                <div><dt>{t('diagnostics.approvals')}</dt><dd>{snapshot.counts.approvalsPending}</dd></div>
                <div><dt>{t('diagnostics.actions')}</dt><dd>{snapshot.counts.actionsActive}</dd></div>
                <div><dt>{t('diagnostics.sources')}</dt><dd>{snapshot.counts.localSources}</dd></div>
                <div><dt>{t('diagnostics.memory')}</dt><dd>{snapshot.counts.memoryEntries}</dd></div>
                <div><dt>{t('diagnostics.automation')}</dt><dd>{t(`sourceSettings.${snapshot.automationMode}`)}</dd></div>
                <div><dt>{t('diagnostics.shell')}</dt><dd>{snapshot.shell.available ? snapshot.shell.backend : t('footer.shellUnavailable')}</dd></div>
                <div><dt>{t('diagnostics.browserTabs')}</dt><dd>{snapshot.browser.tabs}</dd></div>
                <div><dt>{t('diagnostics.browserDownloads')}</dt><dd>{snapshot.browser.downloads}</dd></div>
              </dl>

              <section className="diagnostics-retention" aria-labelledby="agent-computer-title">
                <div>
                  <h3 id="agent-computer-title">{t('diagnostics.agentComputer')}</h3>
                  <p>{t('diagnostics.agentComputerDescription')}</p>
                </div>
                <dl className="diagnostics-grid">
                  {snapshot.agentComputer.providers.map((provider) => (
                    <div key={provider.id}>
                      <dt>{provider.label}</dt>
                      <dd>{provider.available ? t('diagnostics.available') : t('diagnostics.unavailable')}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="diagnostics-retention" aria-labelledby="retention-title">
                <div>
                  <h3 id="retention-title">{t('diagnostics.retentionTitle')}</h3>
                  <p>{t('diagnostics.retentionDescription')}</p>
                </div>
                <div className="diagnostics-retention-actions">
                  <label>
                    <span>{t('diagnostics.retentionDays')}</span>
                    <input type="number" min={30} max={3650} value={retention} onChange={(event) => setRetention(Number(event.target.value))} />
                  </label>
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => void saveRetention()}>{t('common.save')}</button>
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => void runMaintenance()}>{t('diagnostics.runCleanup')}</button>
                </div>
                {snapshot.lastMaintenanceAt !== undefined && (
                  <small>{t('diagnostics.lastCleanup', { time: new Date(snapshot.lastMaintenanceAt).toLocaleString() })}</small>
                )}
              </section>

              <MemorySettingsPanel onChanged={() => {
                void window.barn.diagnostics.get().then(setSnapshot).catch((reason: unknown) => setError(errorMessage(reason)))
              }} />

              <p className="diagnostics-path">{snapshot.stateDirectory}</p>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
