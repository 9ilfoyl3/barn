import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Pin, PinOff, Trash2 } from 'lucide-react'
import type { MemoryEntry, MemorySettings } from '../shared/models'
import { TooltipButton } from './components/TooltipButton'
import { notifySuccess, useErrorToast } from './notifications'
import './memory-settings.css'

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: false,
  useMemories: true,
  generateMemories: true,
  idleMinutes: 360,
  maxEntries: 500,
}

export function MemorySettingsPanel({ onChanged }: { onChanged?(): void }) {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<MemorySettings>(DEFAULT_SETTINGS)
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [query, setQuery] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useErrorToast(error)

  useEffect(() => {
    let active = true
    void Promise.all([window.barn.memory.getSettings(), window.barn.memory.list()])
      .then(([nextSettings, nextEntries]) => {
        if (!active) return
        setSettings(nextSettings)
        setEntries(nextEntries)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle.length === 0) return entries
    return entries.filter((entry) => [entry.title, entry.content, entry.kind, entry.scope, ...entry.tags]
      .some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [entries, query])

  async function saveSettings(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const saved = await window.barn.memory.setSettings(settings)
      setSettings(saved)
      notifySuccess(t('memorySettings.saved'))
      onChanged?.()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function togglePinned(entry: MemoryEntry): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const updated = await window.barn.memory.setPinned(entry.id, !entry.pinned)
      setEntries((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function deleteMemory(id: string): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      await window.barn.memory.delete(id)
      setEntries((current) => current.filter((entry) => entry.id !== id))
      setPendingDelete(undefined)
      notifySuccess(t('memorySettings.deleted'))
      onChanged?.()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="diagnostics-memory" aria-labelledby="memory-settings-title">
      <div className="diagnostics-memory-heading">
        <span className="diagnostics-memory-icon" aria-hidden="true"><Brain size={17} /></span>
        <div>
          <h3 id="memory-settings-title">{t('memorySettings.title')}</h3>
          <p>{t('memorySettings.description')}</p>
        </div>
      </div>

      {loading ? <p className="diagnostics-muted">{t('common.loading')}</p> : (
        <>
          <div className="memory-settings-grid">
            <label className="memory-switch-row">
              <span>
                <strong>{t('memorySettings.enabled')}</strong>
                <small>{t('memorySettings.enabledDescription')}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.enabled}
                onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))}
              />
            </label>
            <label className="memory-switch-row">
              <span>
                <strong>{t('memorySettings.useMemories')}</strong>
                <small>{t('memorySettings.useMemoriesDescription')}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.useMemories}
                disabled={!settings.enabled}
                onChange={(event) => setSettings((current) => ({ ...current, useMemories: event.target.checked }))}
              />
            </label>
            <label className="memory-switch-row">
              <span>
                <strong>{t('memorySettings.generateMemories')}</strong>
                <small>{t('memorySettings.generateMemoriesDescription')}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.generateMemories}
                disabled={!settings.enabled}
                onChange={(event) => setSettings((current) => ({ ...current, generateMemories: event.target.checked }))}
              />
            </label>
          </div>

          <div className="memory-number-grid">
            <label>
              <span>{t('memorySettings.idleMinutes')}</span>
              <input
                type="number"
                min={15}
                max={10_080}
                value={settings.idleMinutes}
                onChange={(event) => setSettings((current) => ({ ...current, idleMinutes: Number(event.target.value) }))}
              />
              <small>{t('memorySettings.idleMinutesDescription')}</small>
            </label>
            <label>
              <span>{t('memorySettings.maxEntries')}</span>
              <input
                type="number"
                min={10}
                max={2_000}
                value={settings.maxEntries}
                onChange={(event) => setSettings((current) => ({ ...current, maxEntries: Number(event.target.value) }))}
              />
              <small>{t('memorySettings.maxEntriesDescription')}</small>
            </label>
          </div>

          <div className="memory-settings-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void saveSettings()}>
              {t('memorySettings.save')}
            </button>
            <span>{t('memorySettings.privacyNote')}</span>
          </div>

          <div className="memory-library">
            <div className="memory-library-heading">
              <div>
                <h4>{t('memorySettings.libraryTitle')}</h4>
                <p>{t('memorySettings.libraryDescription', { count: entries.length })}</p>
              </div>
              <input
                type="search"
                value={query}
                placeholder={t('memorySettings.searchPlaceholder')}
                aria-label={t('memorySettings.searchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {filteredEntries.length === 0 ? (
              <p className="memory-empty">{query.trim().length > 0 ? t('memorySettings.noMatches') : t('memorySettings.empty')}</p>
            ) : (
              <ul className="memory-list">
                {filteredEntries.map((entry) => (
                  <li key={entry.id} className="memory-entry">
                    <div className="memory-entry-main">
                      <div className="memory-entry-title">
                        <strong>{entry.title}</strong>
                        {entry.pinned && <span>{t('memorySettings.pinned')}</span>}
                      </div>
                      <p>{entry.content}</p>
                      <div className="memory-entry-meta">
                        <span>{t(`memorySettings.kinds.${entry.kind}`)}</span>
                        <span>{entry.scope === 'global' ? t('memorySettings.globalScope') : t('memorySettings.workspaceScope')}</span>
                        <time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleDateString(i18n.language)}</time>
                      </div>
                      {entry.tags.length > 0 && (
                        <div className="memory-entry-tags">
                          {entry.tags.map((tag) => <span key={tag}>{tag}</span>)}
                        </div>
                      )}
                    </div>
                    <div className="memory-entry-actions">
                      <TooltipButton
                        className="icon-button"
                        label={entry.pinned ? t('memorySettings.unpin') : t('memorySettings.pin')}
                        disabled={busy}
                        onClick={() => void togglePinned(entry)}
                      >
                        {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </TooltipButton>
                      {pendingDelete === entry.id ? (
                        <>
                          <button className="memory-delete-confirm" type="button" disabled={busy} onClick={() => void deleteMemory(entry.id)}>
                            {t('memorySettings.confirmDelete')}
                          </button>
                          <button className="memory-delete-cancel" type="button" onClick={() => setPendingDelete(undefined)}>
                            {t('common.cancel')}
                          </button>
                        </>
                      ) : (
                        <TooltipButton
                          className="icon-button"
                          label={t('memorySettings.delete', { title: entry.title })}
                          disabled={busy}
                          onClick={() => setPendingDelete(entry.id)}
                        >
                          <Trash2 size={14} />
                        </TooltipButton>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
