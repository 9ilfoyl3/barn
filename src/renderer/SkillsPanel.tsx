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
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { Streamdown } from 'streamdown'
import { Input } from './components/Input'
import type {
  SkillDetail,
  SkillFileContent,
  SkillFileSummary,
  SkillSummary,
} from '../shared/models'
import { notifySuccess, useErrorToast } from './notifications'
import './skills-panel.css'
import { Button } from './components/Button'

type SkillCategory = 'all' | 'system' | 'local' | 'custom'
type SkillEditorState =
  | { mode: 'create' }
  | { mode: 'edit'; skill: SkillDetail }

export function SkillsPanel({ query, onTrySkill }: { query: string; onTrySkill?: (skill: SkillSummary) => void }) {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [category, setCategory] = useState<SkillCategory>('all')
  const [selected, setSelected] = useState<SkillDetail>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [resourcesOpen, setResourcesOpen] = useState(false)
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
      const next = await window.barn.skills.list()
      setSkills(next)
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
      setMenuOpen(false)
      setResourcesOpen(false)
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
      setResourcesOpen(true)
      setMenuOpen(false)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setResourceLoading(undefined)
    }
  }

  function trySkill(skill: SkillDetail): void {
    onTrySkill?.(skill)
    setSelected(undefined)
    setMenuOpen(false)
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
            <Button
              aria-pressed={category === entry.id}
              className={category === entry.id ? 'skill-category-pill active' : 'skill-category-pill'}
              key={entry.id}
              onClick={() => setCategory(entry.id)}
              type="button"
            >
              <span>{entry.label}</span>
              <small>{entry.count}</small>
            </Button>
          ))}
        </div>
        <div className="skills-toolbar-actions">
          <Button
            className="skills-outline-button"
            type="button"
            disabled={refreshing}
            state={refreshing ? 'loading' : 'idle'}
            loadingText={t('plugins.skillUi.rescan')}
            onClick={() => void refreshSkills()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {t('plugins.skillUi.rescan')}
          </Button>
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
          <Button
            className="skills-outline-button"
            type="button"
            disabled={saving}
            state={saving ? 'loading' : 'idle'}
            loadingText={t('plugins.skillUi.importMarkdown')}
            onClick={() => importRef.current?.click()}
          >
            <Upload size={14} aria-hidden="true" />
            {t('plugins.skillUi.importMarkdown')}
          </Button>
          <Button className="skills-primary-button" type="button" onClick={() => setEditor({ mode: 'create' })}>
            <Plus size={14} aria-hidden="true" />
            {t('plugins.skillUi.newSkill')}
          </Button>
        </div>
      </div>

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
              <div className="skill-row-main">
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
              </div>
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
              <Button
                className="skill-row-open"
                type="button"
                aria-label={t('plugins.skillUi.openNamed', { name: skill.name })}
                state={detailLoadingId === skill.id ? 'loading' : 'idle'}
                loadingText=""
                onClick={() => void openSkill(skill)}
              >
                <ChevronRight size={15} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {selected !== undefined && editor === undefined && (
        <div className="skill-detail-backdrop" role="presentation" onMouseDown={() => setSelected(undefined)}>
          <section
            aria-label={selected.name}
            aria-modal="true"
            className="skill-detail-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="skill-detail-header">
              <span className="skill-detail-icon" aria-hidden="true">
                {selected.source === 'system'
                  ? <Sparkles size={21} />
                  : selected.source === 'local'
                    ? <FolderOpen size={21} />
                    : <BookOpen size={21} />}
              </span>
              <div className="skill-detail-heading">
                <h2>{selected.name}</h2>
                <span>{t('plugins.skillUi.skillLabel')}</span>
              </div>
              <div className="skill-detail-controls">
                {selected.source !== 'system' && (
                  <label className="skill-detail-toggle" title={selected.enabled ? t('plugins.skillUi.enabled') : t('plugins.skillUi.disabled')}>
                    <input
                      aria-label={selected.enabled ? t('plugins.skillUi.disableNamed', { name: selected.name }) : t('plugins.skillUi.enableNamed', { name: selected.name })}
                      type="checkbox"
                      checked={selected.enabled}
                      disabled={busyId === selected.id}
                      onChange={() => void toggle(selected)}
                    />
                    <span />
                  </label>
                )}
                <div className="skill-detail-menu-wrap">
                  <Button
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    aria-label={t('plugins.skillUi.moreActions')}
                    className="skill-detail-icon-button"
                    type="button"
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </Button>
                  {menuOpen && (
                    <div className="skill-detail-menu" role="menu">
                      {selected.source === 'custom' && (
                        <Button
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            setMenuOpen(false)
                            setEditor({ mode: 'edit', skill: selected })
                          }}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          {t('plugins.skillUi.edit')}
                        </Button>
                      )}
                      {selected.files.length > 0 && (
                        <Button
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            setMenuOpen(false)
                            setResourcesOpen(true)
                          }}
                        >
                          <FileText size={14} aria-hidden="true" />
                          {t('plugins.skillUi.resources')}
                        </Button>
                      )}
                      <Button role="menuitem" type="button" onClick={() => void copyMarkdown(selected)}>
                        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                        {copied ? t('plugins.skillUi.copied') : t('plugins.skillUi.copyMarkdown')}
                      </Button>
                    </div>
                  )}
                </div>
                <Button className="skill-detail-icon-button" type="button" aria-label={t('common.close')} onClick={() => setSelected(undefined)}>
                  <X size={18} aria-hidden="true" />
                </Button>
              </div>
            </header>

            <p className="skill-detail-description">{selected.description}</p>

            <div className="skill-detail-content">
              <Streamdown className="skill-detail-markdown assistant-markdown" animated={false} isAnimating={false}>
                {selected.instructions}
              </Streamdown>
            </div>

            {resourcesOpen && selected.files.length > 0 && (
              <section className="skill-detail-resources" aria-label={t('plugins.skillUi.resources')}>
                <header className="skill-detail-resources-heading">
                  <strong>{t('plugins.skillUi.resources')}</strong>
                  <Button className="skill-detail-icon-button" type="button" aria-label={t('plugins.skillUi.closeResources')} onClick={() => {
                    setResourcesOpen(false)
                    setResource(undefined)
                  }}>
                    <X size={15} aria-hidden="true" />
                  </Button>
                </header>
                <div className="skill-detail-resource-list">
                  {selected.files.map((file) => (
                    <Button
                      className={resource?.path === file.path ? 'skill-detail-resource active' : 'skill-detail-resource'}
                      key={file.path}
                      type="button"
                      onClick={() => void openResource(file)}
                    >
                      {resourceLoading === file.path
                        ? <LoaderCircle className="spin" size={12} aria-hidden="true" />
                        : <FileText size={12} aria-hidden="true" />}
                      <span>{file.path}</span>
                      <small>{formatBytes(file.size)}</small>
                    </Button>
                  ))}
                </div>
                {resource !== undefined && (
                  <div className="skill-detail-resource-preview" aria-label={resource.path}>
                    {resource.binary || resource.text === undefined ? (
                      <p>{t('plugins.skillUi.binaryResource')}</p>
                    ) : resource.path.endsWith('.md') || resource.path.endsWith('.markdown') ? (
                      <Streamdown className="skill-detail-markdown assistant-markdown" animated={false} isAnimating={false}>
                        {resource.text}
                      </Streamdown>
                    ) : (
                      <pre>{resource.text}</pre>
                    )}
                  </div>
                )}
              </section>
            )}

            <footer className="skill-detail-footer">
              <div>
                {selected.source === 'custom' && (
                  <Button className="skill-detail-secondary danger" type="button" disabled={busyId === selected.id} onClick={() => void removeSkill(selected)}>
                    {t('plugins.skillUi.uninstall')}
                  </Button>
                )}
                {selected.source === 'local' && (
                  <Button className="skill-detail-secondary" type="button" disabled={busyId === selected.id} onClick={() => void toggle(selected)}>
                    {selected.enabled ? t('plugins.skillUi.disable') : t('plugins.skillUi.enable')}
                  </Button>
                )}
              </div>
              <Button className="skill-detail-primary" type="button" onClick={() => trySkill(selected)}>
                <MousePointerClick size={14} aria-hidden="true" />
                {t('plugins.skillUi.tryNow')}
              </Button>
            </footer>
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
        <Button className="skill-dialog-close" type="button" aria-label={t('common.close')} onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className="skill-editor-fields">
        <label>
          <span>{t('plugins.skillUi.name')}</span>
          <Input maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} density="compact" />
        </label>
        <label>
          <span>{t('plugins.skillUi.description')}</span>
          <Input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} density="compact" />
        </label>
        <label>
          <span>{t('plugins.skillUi.instructions')}</span>
          <textarea required rows={14} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        </label>
      </div>
      <footer className="skill-editor-actions">
        <Button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button
          className="primary-button"
          type="submit"
          disabled={busy || name.trim().length === 0 || instructions.trim().length === 0}
          state={busy ? 'loading' : 'idle'}
          loadingText={t('common.saving')}
        >
          {t('common.save')}
        </Button>
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
