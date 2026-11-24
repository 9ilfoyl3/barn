import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Streamdown } from 'streamdown'
import type {
  SkillDetail,
  SkillDiscoveryStatus,
  SkillFileContent,
  SkillFileSummary,
  SkillSummary,
} from '../shared/models'
import { notifySuccess, useErrorToast } from './notifications'
import './skills-panel.css'

type SkillCategory = 'all' | 'system' | 'local' | 'custom'
type SkillEditorState =
  | { mode: 'create' }
  | { mode: 'edit'; skill: SkillDetail }

export function SkillsPanel({ query }: { query: string }) {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [discovery, setDiscovery] = useState<SkillDiscoveryStatus>()
  const [category, setCategory] = useState<SkillCategory>('all')
  const [selected, setSelected] = useState<SkillDetail>()
  const [resource, setResource] = useState<SkillFileContent>()
  const [resourceLoading, setResourceLoading] = useState<string>()
  const [editor, setEditor] = useState<SkillEditorState>()
  const [loading, setLoading] = useState(true)
  const [detailLoadingId, setDetailLoadingId] = useState<string>()
  const [busyId, setBusyId] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  useErrorToast(error)

  useEffect(() => {
    void reload()
    return window.barn.skills.onEvent(() => void reload())
  }, [])

  async function reload(): Promise<void> {
    try {
      const [next, status] = await Promise.all([
        window.barn.skills.list(),
        window.barn.skills.discovery(),
      ])
      setSkills(next)
      setDiscovery(status)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function openSkill(skill: SkillSummary): Promise<void> {
    setDetailLoadingId(skill.id)
    setError(undefined)
    try {
      setSelected(await window.barn.skills.get(skill.id))
      setResource(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDetailLoadingId(undefined)
    }
  }

  async function toggle(skill: SkillSummary): Promise<void> {
    setBusyId(skill.id)
    setError(undefined)
    try {
      const updated = await window.barn.skills.setEnabled(skill.id, !skill.enabled)
      setSkills((current) => current.map((entry) => entry.id === updated.id ? summary(updated) : entry))
      if (selected?.id === updated.id) setSelected(updated)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  async function refreshSkills(): Promise<void> {
    setRefreshing(true)
    setError(undefined)
    try {
      const snapshot = await window.barn.skills.refresh()
      setSkills(snapshot.skills)
      setDiscovery(snapshot.discovery)
      notifySuccess(t('plugins.skillUi.rescanned'))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRefreshing(false)
    }
  }

  async function openResource(file: SkillFileSummary): Promise<void> {
    if (selected === undefined) return
    setResourceLoading(file.path)
    setError(undefined)
    try {
      setResource(await window.barn.skills.readFile(selected.id, file.path))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setResourceLoading(undefined)
    }
  }

  async function saveSkill(input: { name: string; description: string; instructions: string }): Promise<void> {
    setSaving(true)
    setError(undefined)
    try {
      if (editor?.mode === 'edit') {
        const updated = await window.barn.skills.update(editor.skill.id, input)
        setSelected(updated)
        notifySuccess(t('plugins.skillUi.updated'))
      } else {
        const created = await window.barn.skills.create(input)
        setSelected(created)
        notifySuccess(t('plugins.skillUi.created'))
      }
      setEditor(undefined)
      setCopied(false)
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  async function removeSkill(skill: SkillDetail): Promise<void> {
    if (!window.confirm(t('plugins.skillUi.deleteConfirm', { name: skill.name }))) return
    setBusyId(skill.id)
    setError(undefined)
    try {
      await window.barn.skills.remove(skill.id)
      setSelected(undefined)
      setEditor(undefined)
      notifySuccess(t('plugins.skillUi.deleted'))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  async function copyMarkdown(skill: SkillDetail): Promise<void> {
    try {
      await navigator.clipboard.writeText(skill.instructions)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function importSkill(file: File): Promise<void> {
    setSaving(true)
    setError(undefined)
    try {
      const parsed = parseSkillMarkdown(await file.text(), file.name)
      const created = await window.barn.skills.create(parsed)
      setSelected(created)
      notifySuccess(t('plugins.skillUi.imported'))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
      if (importRef.current !== null) importRef.current.value = ''
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = skills.filter((skill) => (
    (category === 'all' || skill.source === category)
    && (normalizedQuery.length === 0
      || `${skill.name} ${skill.description} ${skill.providerLabel}`.toLocaleLowerCase().includes(normalizedQuery))
  ))
  const categories: Array<{ id: SkillCategory; label: string; count: number }> = [
    { id: 'all', label: t('plugins.skillUi.all'), count: skills.length },
    { id: 'system', label: t('plugins.skillUi.system'), count: skills.filter((skill) => skill.source === 'system').length },
    { id: 'local', label: t('plugins.skillUi.local'), count: skills.filter((skill) => skill.source === 'local').length },
    { id: 'custom', label: t('plugins.skillUi.custom'), count: skills.filter((skill) => skill.source === 'custom').length },
  ]
  const sourceLabel = (skill: SkillSummary): string => skill.source === 'system'
    ? t('plugins.skillUi.system')
    : skill.source === 'custom'
      ? t('plugins.skillUi.custom')
      : skill.providerLabel

  return (
    <div className="skills-panel">
      <div className="skills-toolbar">
        <div className="skill-category-pills" role="group" aria-label={t('plugins.skillUi.categories')}>
          {categories.map((entry) => (
            <button
              aria-pressed={category === entry.id}
              className={category === entry.id ? 'skill-category-pill active' : 'skill-category-pill'}
              key={entry.id}
              onClick={() => setCategory(entry.id)}
              type="button"
            >
              <span>{entry.label}</span>
              <small>{entry.count}</small>
            </button>
          ))}
        </div>
        <div className="skills-toolbar-actions">
          <button
            className="skills-outline-button"
            type="button"
            disabled={refreshing}
            onClick={() => void refreshSkills()}
          >
            <RefreshCw className={refreshing ? 'spin' : undefined} size={14} aria-hidden="true" />
            {t('plugins.skillUi.rescan')}
          </button>
          <input
            ref={importRef}
            accept=".md,.markdown,text/markdown,text/plain"
            aria-label={t('plugins.skillUi.importMarkdown')}
            className="skills-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void importSkill(file)
            }}
            tabIndex={-1}
            type="file"
          />
          <button className="skills-outline-button" type="button" disabled={saving} onClick={() => importRef.current?.click()}>
            <Upload size={14} aria-hidden="true" />
            {t('plugins.skillUi.importMarkdown')}
          </button>
          <button className="skills-primary-button" type="button" onClick={() => setEditor({ mode: 'create' })}>
            <Plus size={14} aria-hidden="true" />
            {t('plugins.skillUi.newSkill')}
          </button>
        </div>
      </div>

      {discovery !== undefined && discovery.warnings.length > 0 && (
        <details className="skills-discovery-warning">
          <summary>{t('plugins.skillUi.discoveryWarnings', { count: discovery.warnings.length })}</summary>
          <ul>
            {discovery.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </details>
      )}

      {loading ? (
        <div className="skills-loading" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          <span>{t('common.loading')}</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="skills-empty">
          <BookOpen size={20} aria-hidden="true" />
          <strong>{t('plugins.skillUi.noResults')}</strong>
          <span>{t('plugins.skillUi.noResultsDescription')}</span>
        </div>
      ) : (
        <ul className="skills-list">
          {visible.map((skill) => (
            <li className={skill.enabled ? 'skill-row' : 'skill-row disabled'} key={skill.id}>
              <button className="skill-row-main" type="button" onClick={() => void openSkill(skill)}>
                <span className="skill-row-icon" aria-hidden="true">
                  {skill.source === 'system'
                    ? <Sparkles size={18} />
                    : skill.source === 'local'
                      ? <FolderOpen size={18} />
                      : <BookOpen size={18} />}
                </span>
                <span className="skill-row-copy">
                  <span className="skill-row-title">
                    <strong>{skill.name}</strong>
                    <span className="skill-source-badge" data-provider={skill.provider}>{sourceLabel(skill)}</span>
                    {skill.fileCount > 0 && (
                      <span className="skill-file-count" title={t('plugins.skillUi.resourceCount', { count: skill.fileCount })}>
                        <FileText size={11} aria-hidden="true" />
                        {skill.fileCount}
                      </span>
                    )}
                  </span>
                  <small>{skill.description}</small>
                </span>
              </button>
              {skill.source !== 'system' ? (
                <label className="skill-switch" title={skill.enabled ? t('plugins.skillUi.enabled') : t('plugins.skillUi.disabled')}>
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    disabled={busyId === skill.id}
                    onChange={() => void toggle(skill)}
                  />
                  <span />
                </label>
              ) : (
                <span className="skill-lock" title={t('plugins.skillUi.systemReadOnly')}>
                  <LockKeyhole size={13} aria-hidden="true" />
                </span>
              )}
              <button className="skill-row-open" type="button" aria-label={t('plugins.skillUi.openNamed', { name: skill.name })} onClick={() => void openSkill(skill)}>
                {detailLoadingId === skill.id
                  ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
                  : <ChevronRight size={15} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected !== undefined && editor === undefined && (
        <div className="skill-dialog-backdrop" role="presentation" onMouseDown={() => setSelected(undefined)}>
          <section
            aria-label={selected.name}
            aria-modal="true"
            className="skill-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="skill-dialog-header">
              <span className="skill-dialog-icon" aria-hidden="true">
                {selected.source === 'system'
                  ? <Sparkles size={20} />
                  : selected.source === 'local'
                    ? <FolderOpen size={20} />
                    : <BookOpen size={20} />}
              </span>
              <div>
                <span className="skill-dialog-kicker">
                  {t('plugins.skillUi.detailKicker')} · {sourceLabel(selected)}
                </span>
                <h2>{selected.name}</h2>
                <p>{selected.description}</p>
              </div>
              <button className="skill-dialog-close" type="button" aria-label={t('common.close')} onClick={() => setSelected(undefined)}>
                <X size={16} aria-hidden="true" />
              </button>
            </header>

            <div className="skill-dialog-actions">
              {selected.source !== 'system' && (
                <label className="skill-dialog-toggle">
                  <span>{selected.enabled ? t('plugins.skillUi.enabled') : t('plugins.skillUi.disabled')}</span>
                  <span className="skill-switch">
                    <input
                      type="checkbox"
                      checked={selected.enabled}
                      disabled={busyId === selected.id}
                      onChange={() => void toggle(selected)}
                    />
                    <span />
                  </span>
                </label>
              )}
              {selected.source === 'custom' && (
                <>
                  <button className="skills-outline-button" type="button" onClick={() => setEditor({ mode: 'edit', skill: selected })}>
                    <Pencil size={13} aria-hidden="true" />
                    {t('plugins.skillUi.edit')}
                  </button>
                  <button className="skills-outline-button danger" type="button" disabled={busyId === selected.id} onClick={() => void removeSkill(selected)}>
                    <Trash2 size={13} aria-hidden="true" />
                    {t('plugins.skillUi.delete')}
                  </button>
                </>
              )}
              {selected.source === 'local' && (
                <span className="skill-readonly-note">{t('plugins.skillUi.externalReadOnly')}</span>
              )}
              <button className="skills-outline-button" type="button" onClick={() => void copyMarkdown(selected)}>
                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                {copied ? t('plugins.skillUi.copied') : t('plugins.skillUi.copyMarkdown')}
              </button>
            </div>

            {selected.location !== undefined && (
              <div className="skill-source-location" title={selected.location}>
                <FolderOpen size={12} aria-hidden="true" />
                <span>{selected.location}</span>
              </div>
            )}

            {selected.files.length > 0 && (
              <section className="skill-resources" aria-label={t('plugins.skillUi.resources')}>
                <div className="skill-resources-heading">
                  <h3>{t('plugins.skillUi.resources')}</h3>
                  <span>{t('plugins.skillUi.resourceCount', { count: selected.files.length })}</span>
                </div>
                <div className="skill-resource-list">
                  {selected.files.map((file) => (
                    <button
                      className={resource?.path === file.path ? 'skill-resource active' : 'skill-resource'}
                      key={file.path}
                      type="button"
                      onClick={() => void openResource(file)}
                    >
                      {resourceLoading === file.path
                        ? <LoaderCircle className="spin" size={12} aria-hidden="true" />
                        : <FileText size={12} aria-hidden="true" />}
                      <span>{file.path}</span>
                      <small>{formatBytes(file.size)}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <div className="skill-dialog-content">
              <Streamdown className="skill-dialog-markdown assistant-markdown" animated={false} isAnimating={false}>
                {selected.instructions}
              </Streamdown>
            </div>

            {resource !== undefined && (
              <section className="skill-resource-preview" aria-label={resource.path}>
                <header>
                  <div>
                    <strong>{resource.path}</strong>
                    <span>{resource.mediaType} · {formatBytes(resource.size)}</span>
                  </div>
                  <button className="skill-dialog-close" type="button" aria-label={t('common.close')} onClick={() => setResource(undefined)}>
                    <X size={15} aria-hidden="true" />
                  </button>
                </header>
                {resource.binary || resource.text === undefined ? (
                  <p>{t('plugins.skillUi.binaryResource')}</p>
                ) : resource.path.endsWith('.md') || resource.path.endsWith('.markdown') ? (
                  <Streamdown className="skill-dialog-markdown assistant-markdown" animated={false} isAnimating={false}>
                    {resource.text}
                  </Streamdown>
                ) : (
                  <pre>{resource.text}</pre>
                )}
              </section>
            )}
          </section>
        </div>
      )}

      {editor !== undefined && (
        <div className="skill-dialog-backdrop" role="presentation" onMouseDown={() => setEditor(undefined)}>
          <SkillEditor
            busy={saving}
            initial={editor.mode === 'edit' ? editor.skill : undefined}
            onCancel={() => setEditor(undefined)}
            onSave={(input) => void saveSkill(input)}
          />
        </div>
      )}
    </div>
  )
}

function SkillEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial?: SkillDetail | undefined
  busy: boolean
  onCancel(): void
  onSave(input: { name: string; description: string; instructions: string }): void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [instructions, setInstructions] = useState(initial?.instructions ?? '')
  return (
    <form
      aria-label={initial === undefined ? t('plugins.skillUi.createTitle') : t('plugins.skillUi.editTitle')}
      aria-modal="true"
      className="skill-editor-dialog"
      onMouseDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, description, instructions })
      }}
      role="dialog"
    >
      <header className="skill-dialog-header compact">
        <div>
          <span className="skill-dialog-kicker">{t('plugins.skillUi.kicker')}</span>
          <h2>{initial === undefined ? t('plugins.skillUi.createTitle') : t('plugins.skillUi.editTitle')}</h2>
        </div>
        <button className="skill-dialog-close" type="button" aria-label={t('common.close')} onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="skill-editor-fields">
        <label>
          <span>{t('plugins.skillUi.name')}</span>
          <input maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>{t('plugins.skillUi.description')}</span>
          <input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          <span>{t('plugins.skillUi.instructions')}</span>
          <textarea required rows={14} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        </label>
      </div>
      <footer className="skill-editor-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="primary-button" type="submit" disabled={busy || name.trim().length === 0 || instructions.trim().length === 0}>
          {busy && <LoaderCircle className="spin" size={14} aria-hidden="true" />}
          {t('common.save')}
        </button>
      </footer>
    </form>
  )
}

function parseSkillMarkdown(text: string, filename: string): { name: string; description: string; instructions: string } {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  let name = filename.replace(/\.(?:md|markdown)$/iu, '').trim()
  let description = ''
  let instructions = normalized
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/u.exec(normalized)
  if (frontmatter !== null) {
    instructions = normalized.slice(frontmatter[0].length).trim()
    const nameMatch = /^name:\s*(.+)$/imu.exec(frontmatter[1] ?? '')
    const descriptionMatch = /^description:\s*(.+)$/imu.exec(frontmatter[1] ?? '')
    if (nameMatch?.[1] !== undefined) name = stripQuotes(nameMatch[1].trim())
    if (descriptionMatch?.[1] !== undefined) description = stripQuotes(descriptionMatch[1].trim())
  }
  if (name.length === 0) {
    const heading = /^#\s+(.+)$/mu.exec(instructions)?.[1]?.trim()
    if (heading !== undefined) name = heading
  }
  if (description.length === 0) {
    const candidate = instructions.split('\n').find((line) => line.trim().length > 0 && !line.startsWith('#'))?.trim()
    description = candidate?.slice(0, 240) ?? ''
  }
  if (name.length === 0 || instructions.length === 0) throw new Error('Markdown skill needs a name and instructions')
  return { name, description, instructions }
}

function stripQuotes(value: string): string {
  return value.replace(/^(['"])(.*)\1$/u, '$2')
}

function summary(skill: SkillDetail): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: skill.enabled,
    updatedAt: skill.updatedAt,
    provider: skill.provider,
    providerLabel: skill.providerLabel,
    editable: skill.editable,
    fileCount: skill.fileCount,
    ...(skill.location === undefined ? {} : { location: skill.location }),
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
