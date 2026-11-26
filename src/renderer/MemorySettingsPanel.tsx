import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, LoaderCircle, Pencil, Pin, PinOff, Settings2, Trash2, X } from 'lucide-react'
import type { MemoryDocument, MemoryDocumentName, MemoryDocumentRevision, MemoryEntry, MemorySettings } from '../shared/models'
import { Input } from './components/Input'
import { notifySuccess, useErrorToast } from './notifications'
import './memory-settings.css'
import { Button } from './components/Button'

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: false,
  useMemories: true,
  generateMemories: true,
  idleMinutes: 360,
  maxEntries: 500,
  memoryCharLimit: 2_200,
  userCharLimit: 2_200,
}

const EMPTY_DOCUMENTS: Record<MemoryDocumentName, MemoryDocument> = {
  memory: { name: 'memory', content: '', charLimit: 2_200, version: 0 },
  user: { name: 'user', content: '', charLimit: 2_200, version: 0 },
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function charCount(content: string): number {
  return Array.from(content).length
}

export function MemorySettingsPanel({ onChanged }: { onChanged?(): void }) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<MemorySettings>(DEFAULT_SETTINGS)
  const [documents, setDocuments] = useState<Record<MemoryDocumentName, MemoryDocument>>(EMPTY_DOCUMENTS)
  const [persisted, setPersisted] = useState<Record<MemoryDocumentName, string>>({ memory: '', user: '' })
  const [candidates, setCandidates] = useState<MemoryEntry[]>([])
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [revisions, setRevisions] = useState<Record<MemoryDocumentName, MemoryDocumentRevision[]>>({ memory: [], user: [] })
  const [activeDocument, setActiveDocument] = useState<MemoryDocumentName>('memory')
  const [loading, setLoading] = useState(true)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [editing, setEditing] = useState(false)
  const [adjustingLimit, setAdjustingLimit] = useState(false)
  const [limitDraft, setLimitDraft] = useState('2200')
  const [entryBusyId, setEntryBusyId] = useState<string>()
  const [editingEntry, setEditingEntry] = useState<{ id: string; title: string; content: string }>()
  const [error, setError] = useState<string>()
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)

  useErrorToast(error)

  useEffect(() => {
    let active = true
    void Promise.all([
      window.barn.memory.getSettings(),
      window.barn.memory.getDocument('memory'),
      window.barn.memory.getDocument('user'),
      window.barn.memory.list(),
      window.barn.memory.listCandidates(),
      window.barn.memory.listDocumentRevisions('memory'),
      window.barn.memory.listDocumentRevisions('user'),
    ]).then(([nextSettings, memory, user, activeEntries, nextCandidates, memoryRevisions, userRevisions]) => {
      if (!active) return
      setSettings(nextSettings)
      setDocuments({ memory, user })
      setPersisted({ memory: memory.content, user: user.content })
      setEntries(activeEntries)
      setCandidates(nextCandidates)
      setRevisions({ memory: memoryRevisions, user: userRevisions })
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  const document = documents[activeDocument]
  const count = charCount(document.content)
  const percentage = document.charLimit > 0 ? Math.min(100, Math.round((count / document.charLimit) * 100)) : 0
  const dirty = document.content !== persisted[activeDocument]
  const overLimit = count > document.charLimit
  const limitSetting = activeDocument === 'memory' ? 'memoryCharLimit' : 'userCharLimit'

  async function saveCurrentDocument(): Promise<boolean> {
    if (savePromiseRef.current !== null) return savePromiseRef.current
    if (!dirty) return true
    if (overLimit) {
      setError(t('memorySettings.documentLimitExceeded', { limit: document.charLimit }))
      return false
    }
    const save = (async (): Promise<boolean> => {
      setSaveState('saving')
      setError(undefined)
      try {
        const saved = await window.barn.memory.saveDocument(activeDocument, document.content, document.version)
        const nextRevisions = await window.barn.memory.listDocumentRevisions(activeDocument)
        setDocuments((current) => ({ ...current, [activeDocument]: saved }))
        setPersisted((current) => ({ ...current, [activeDocument]: saved.content }))
        setRevisions((current) => ({ ...current, [activeDocument]: nextRevisions }))
        setSaveState('saved')
        onChanged?.()
        return true
      } catch (reason) {
        setSaveState('error')
        setError(errorMessage(reason))
        return false
      } finally {
        savePromiseRef.current = null
      }
    })()
    savePromiseRef.current = save
    return save
  }

  async function restoreRevision(revision: MemoryDocumentRevision): Promise<void> {
    setError(undefined)
    try {
      const saved = await window.barn.memory.saveDocument(activeDocument, revision.content, document.version)
      const nextRevisions = await window.barn.memory.listDocumentRevisions(activeDocument)
      setDocuments((current) => ({ ...current, [activeDocument]: saved }))
      setPersisted((current) => ({ ...current, [activeDocument]: saved.content }))
      setRevisions((current) => ({ ...current, [activeDocument]: nextRevisions }))
      setSaveState('saved')
      notifySuccess(t('memorySettings.revisionRestored', { version: revision.version }))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  function updateContent(content: string): void {
    setDocuments((current) => ({
      ...current,
      [activeDocument]: { ...current[activeDocument], content },
    }))
    setSaveState('idle')
  }

  async function switchDocument(name: MemoryDocumentName): Promise<void> {
    if (name === activeDocument) return
    const saved = await saveCurrentDocument()
    if (!saved) return
    setEditing(false)
    setAdjustingLimit(false)
    setError(undefined)
    setSaveState('idle')
    setActiveDocument(name)
  }

  function beginLimitAdjustment(): void {
    setLimitDraft(String(document.charLimit))
    setAdjustingLimit(true)
  }

  async function applyLimit(): Promise<void> {
    const parsed = Number(limitDraft)
    if (!Number.isFinite(parsed) || parsed < 200 || parsed > 20_000) {
      setError(t('memorySettings.invalidCharLimit'))
      return
    }
    setError(undefined)
    try {
      const next = await window.barn.memory.setSettings({ [limitSetting]: Math.floor(parsed) })
      setSettings(next)
      const nextLimit = activeDocument === 'memory' ? next.memoryCharLimit : next.userCharLimit
      setDocuments((current) => ({
        ...current,
        [activeDocument]: { ...current[activeDocument], charLimit: nextLimit },
      }))
      setAdjustingLimit(false)
      notifySuccess(t('memorySettings.limitSaved'))
      onChanged?.()
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function saveRuntimeSettings(): Promise<void> {
    setSettingsBusy(true)
    setError(undefined)
    try {
      const saved = await window.barn.memory.setSettings(settings)
      setSettings(saved)
      setDocuments((current) => ({
        memory: { ...current.memory, charLimit: saved.memoryCharLimit },
        user: { ...current.user, charLimit: saved.userCharLimit },
      }))
      notifySuccess(t('memorySettings.saved'))
      onChanged?.()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSettingsBusy(false)
    }
  }

  async function handleEditorKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): Promise<void> {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      await saveCurrentDocument()
    }
  }

  async function refreshMemoryLists(): Promise<void> {
    const [nextEntries, nextCandidates] = await Promise.all([
      window.barn.memory.list(),
      window.barn.memory.listCandidates(),
    ])
    setEntries(nextEntries)
    setCandidates(nextCandidates)
  }

  async function runEntryAction(id: string, action: () => Promise<unknown>): Promise<void> {
    setEntryBusyId(id)
    setError(undefined)
    try {
      await action()
      await refreshMemoryLists()
      setEditingEntry(undefined)
      onChanged?.()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setEntryBusyId(undefined)
    }
  }

  async function saveEntryEdit(): Promise<void> {
    if (editingEntry === undefined) return
    const entry = [...entries, ...candidates].find((item) => item.id === editingEntry.id)
    if (entry === undefined) return
    await runEntryAction(entry.id, () => window.barn.memory.update({
      id: entry.id,
      expectedVersion: entry.version,
      title: editingEntry.title,
      content: editingEntry.content,
    }))
  }

  const title = activeDocument === 'memory'
    ? t('memorySettings.memoryDocumentTitle')
    : t('memorySettings.userDocumentTitle')
  const description = activeDocument === 'memory'
    ? t('memorySettings.memoryDocumentDescription')
    : t('memorySettings.userDocumentDescription')
  const fileName = activeDocument === 'memory' ? 'MEMORY.md' : 'USER.md'

  const renderMemoryEntry = (entry: MemoryEntry, candidate = false) => {
    const busy = entryBusyId === entry.id
    const isEditing = editingEntry?.id === entry.id
    return (
      <li className={`memory-entry-card${candidate ? ' candidate' : ''}`} key={entry.id}>
        {isEditing ? (
          <div className="memory-entry-editor">
            <label>
              <span>{t('memorySettings.entryTitle')}</span>
              <Input
                value={editingEntry.title}
                maxLength={120}
                onChange={(event) => setEditingEntry((current) => current === undefined ? current : { ...current, title: event.target.value })}
                density="compact"
              />
            </label>
            <label>
              <span>{t('memorySettings.entryContent')}</span>
              <textarea
                value={editingEntry.content}
                maxLength={2_000}
                onChange={(event) => setEditingEntry((current) => current === undefined ? current : { ...current, content: event.target.value })}
              />
            </label>
            <div className="memory-entry-editor-actions">
              <Button
                type="button"
                disabled={busy}
                state={busy ? 'loading' : 'idle'}
                loadingText={t('common.saving')}
                onClick={() => void saveEntryEdit()}
              >
                {t('common.save')}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setEditingEntry(undefined)}>{t('common.cancel')}</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="memory-entry-heading">
              <div>
                <strong>{entry.title}</strong>
                {entry.pinned && <span className="memory-entry-pill">{t('memorySettings.pinned')}</span>}
              </div>
              <span className="memory-entry-version">v{entry.version}</span>
            </div>
            <p>{entry.content}</p>
            <div className="memory-entry-meta">
              <span>{t(`memorySettings.kinds.${entry.kind}`)}</span>
              <span>{entry.scope === 'global' ? t('memorySettings.globalScope') : t('memorySettings.workspaceScope')}</span>
              <span>{Math.round(entry.confidence * 100)}%</span>
              {entry.sourceRefs.length > 0 && <span>{t('memorySettings.sourceCount', { count: entry.sourceRefs.length })}</span>}
            </div>
            <div className="memory-entry-actions">
              <Button
                type="button"
                disabled={busy}
                onClick={() => setEditingEntry({ id: entry.id, title: entry.title, content: entry.content })}
              >
                <Pencil size={13} aria-hidden="true" />{t('memorySettings.edit')}
              </Button>
              {candidate ? (
                <>
                  <Button
                    type="button"
                    className="confirm"
                    disabled={busy}
                    onClick={() => void runEntryAction(entry.id, () => window.barn.memory.confirm(entry.id))}
                  >
                    <Check size={13} aria-hidden="true" />{t('memorySettings.confirm')}
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void runEntryAction(entry.id, () => window.barn.memory.reject(entry.id))}
                  >
                    <X size={13} aria-hidden="true" />{t('memorySettings.reject')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void runEntryAction(entry.id, () => window.barn.memory.setPinned(entry.id, !entry.pinned))}
                  >
                    {entry.pinned
                      ? <><PinOff size={13} aria-hidden="true" />{t('memorySettings.unpin')}</>
                      : <><Pin size={13} aria-hidden="true" />{t('memorySettings.pin')}</>}
                  </Button>
                  <Button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void runEntryAction(entry.id, () => window.barn.memory.delete(entry.id))}
                  >
                    <Trash2 size={13} aria-hidden="true" />{t('memorySettings.deleteEntry')}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </li>
    )
  }

  return (
    <div className="memory-document-page">
      <div className="memory-document-tabs" role="tablist" aria-label={t('memorySettings.documentTabsLabel')}>
        <Button
          className={activeDocument === 'memory' ? 'active' : ''}
          type="button"
          role="tab"
          aria-selected={activeDocument === 'memory'}
          onClick={() => void switchDocument('memory')}
        >
          {t('memorySettings.memoryTab')}
        </Button>
        <Button
          className={activeDocument === 'user' ? 'active' : ''}
          type="button"
          role="tab"
          aria-selected={activeDocument === 'user'}
          onClick={() => void switchDocument('user')}
        >
          {t('memorySettings.userTab')}
        </Button>
      </div>

      {loading ? <p className="memory-document-loading">{t('common.loading')}</p> : (
        <>
          <section className="memory-document-stats" aria-labelledby="memory-document-stats-title">
            <div className="memory-document-stats-heading">
              <div>
                <h2 id="memory-document-stats-title">{title}</h2>
                <p><strong>{fileName}</strong> · {description}</p>
              </div>
              <span className="memory-document-percentage">{percentage}%</span>
            </div>

            <div className="memory-document-usage">
              <strong>{count}</strong>
              <span>/</span>
              <span>{document.charLimit}</span>
              <span>{t('memorySettings.characters')}</span>
              <span>{t('memorySettings.currentUsage')}</span>
              <span>/</span>
              <span>{t('memorySettings.charLimit')}</span>
              {!adjustingLimit ? (
                <Button type="button" className="memory-limit-button" onClick={beginLimitAdjustment}>
                  {t('memorySettings.adjustLimit')}
                </Button>
              ) : (
                <span className="memory-limit-editor">
                  <Input
                    aria-label={t('memorySettings.charLimit')}
                    type="number"
                    min={200}
                    max={20_000}
                    value={limitDraft}
                    onChange={(event) => setLimitDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void applyLimit()
                      if (event.key === 'Escape') setAdjustingLimit(false)
                    }}
                    density="compact"
                  />
                  <Button type="button" onClick={() => void applyLimit()}>{t('memorySettings.applyLimit')}</Button>
                  <Button type="button" onClick={() => setAdjustingLimit(false)}>{t('memorySettings.cancelLimit')}</Button>
                </span>
              )}
            </div>

            <div
              className={`memory-document-progress${overLimit ? ' over-limit' : ''}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={document.charLimit}
              aria-valuenow={Math.min(count, document.charLimit)}
              aria-label={t('memorySettings.currentUsage')}
            >
              <span style={{ width: `${percentage}%` }} />
            </div>
          </section>

          {document.charLimit === 2_200 && (
            <p className="memory-document-limit-note">{t('memorySettings.defaultLimitNote')}</p>
          )}

          <section className="memory-document-editor">
            {document.content.length > 0 && (
              <div className="memory-document-editor-heading">
                <span>{fileName}</span>
                <span className={`memory-save-state ${saveState}`} aria-live="polite">
                  {saveState === 'saving' && <LoaderCircle size={13} aria-hidden="true" />}
                  {saveState === 'saved' && <Check size={13} aria-hidden="true" />}
                  {saveState === 'error' && <AlertCircle size={13} aria-hidden="true" />}
                  {saveState === 'saving'
                    ? t('memorySettings.saving')
                    : saveState === 'saved'
                      ? t('memorySettings.savedShort')
                      : saveState === 'error'
                        ? t('memorySettings.saveFailed')
                        : dirty
                          ? t('memorySettings.unsaved')
                          : t('memorySettings.autoSaveHint')}
                </span>
              </div>
            )}

            {(editing || document.content.length > 0) ? (
              <textarea
                ref={editorRef}
                aria-label={fileName}
                value={document.content}
                onChange={(event) => updateContent(event.target.value)}
                onFocus={() => setEditing(true)}
                onBlur={() => { setEditing(false); void saveCurrentDocument() }}
                onKeyDown={(event) => void handleEditorKeyDown(event)}
                placeholder={t('memorySettings.documentPlaceholder', { file: fileName })}
                spellCheck={false}
              />
            ) : (
              <Button
                className="memory-document-empty"
                type="button"
                onClick={() => {
                  setEditing(true)
                  window.requestAnimationFrame(() => editorRef.current?.focus())
                }}
              >
                {t('memorySettings.emptyFile', { file: fileName })}
              </Button>
            )}

            {overLimit && (
              <p className="memory-document-error">
                <AlertCircle size={14} aria-hidden="true" />
                {t('memorySettings.documentLimitExceeded', { limit: document.charLimit })}
              </p>
            )}
          </section>

          {revisions[activeDocument].length > 0 && (
            <details className="memory-revision-panel">
              <summary>
                <span>{t('memorySettings.revisionHistory')}</span>
                <span className="memory-review-count">{revisions[activeDocument].length}</span>
              </summary>
              <ul className="memory-revision-list">
                {revisions[activeDocument].map((revision) => (
                  <li key={revision.version}>
                    <div>
                      <strong>v{revision.version}</strong>
                      <span>{new Date(revision.archivedAt).toLocaleString()}</span>
                    </div>
                    <Button type="button" onClick={() => void restoreRevision(revision)}>
                      {t('memorySettings.restoreRevision')}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <details className="memory-review-panel" open={candidates.length > 0}>
            <summary>
              <span>{t('memorySettings.candidatesTitle')}</span>
              <span className="memory-review-count">{candidates.length}</span>
            </summary>
            <p className="memory-review-description">{t('memorySettings.candidatesDescription')}</p>
            {candidates.length === 0 ? (
              <p className="memory-review-empty">{t('memorySettings.noCandidates')}</p>
            ) : (
              <ul className="memory-entry-list">
                {candidates.map((entry) => renderMemoryEntry(entry, true))}
              </ul>
            )}
          </details>

          <details className="memory-review-panel memory-library-panel">
            <summary>
              <span>{t('memorySettings.libraryTitle')}</span>
              <span className="memory-review-count">{entries.length}</span>
            </summary>
            <p className="memory-review-description">{t('memorySettings.libraryDescription', { count: entries.length })}</p>
            {entries.length === 0 ? (
              <p className="memory-review-empty">{t('memorySettings.empty')}</p>
            ) : (
              <ul className="memory-entry-list">
                {entries.map((entry) => renderMemoryEntry(entry))}
              </ul>
            )}
          </details>

          <details className="memory-runtime-settings">
            <summary>
              <Settings2 size={15} aria-hidden="true" />
              <span>{t('memorySettings.runtimeSettings')}</span>
            </summary>
            <p className="memory-runtime-description">{t('memorySettings.runtimeSettingsDescription')}</p>
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
                  onChange={(event) => setSettings((current) => ({ ...current, generateMemories: event.target.checked }))}
                />
              </label>
            </div>
            <div className="memory-number-grid">
              <label>
                <span>{t('memorySettings.idleMinutes')}</span>
                <Input
                  type="number"
                  min={15}
                  max={10_080}
                  value={settings.idleMinutes}
                  onChange={(event) => setSettings((current) => ({ ...current, idleMinutes: Number(event.target.value) }))}
                  density="compact"
                />
                <small>{t('memorySettings.idleMinutesDescription')}</small>
              </label>
              <label>
                <span>{t('memorySettings.maxEntries')}</span>
                <Input
                  type="number"
                  min={10}
                  max={2_000}
                  value={settings.maxEntries}
                  onChange={(event) => setSettings((current) => ({ ...current, maxEntries: Number(event.target.value) }))}
                  density="compact"
                />
                <small>{t('memorySettings.maxEntriesDescription')}</small>
              </label>
            </div>
            <div className="memory-settings-actions">
              <Button
                className="secondary-button"
                type="button"
                disabled={settingsBusy}
                state={settingsBusy ? 'loading' : 'idle'}
                loadingText={t('memorySettings.saving')}
                onClick={() => void saveRuntimeSettings()}
              >
                {t('memorySettings.save')}
              </Button>
              <span>{t('memorySettings.privacyNote')}</span>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
