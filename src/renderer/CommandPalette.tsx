import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Inbox, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task } from '../shared/models'
import { Input as BeuiInput } from './components/beui/components/motion/input'

export interface CommandPaletteProps {
  open: boolean
  tasks: Task[]
  onClose: () => void
  onOpenTask: (task: Task) => void
  onOpenTasks: () => void
}

export function CommandPalette({ open, tasks, onClose, onOpenTask, onOpenTasks }: CommandPaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const normalized = query.trim().toLocaleLowerCase()
  const results = tasks
    .filter((task) => normalized === '' || `${task.title} ${task.detail ?? ''}`.toLocaleLowerCase().includes(normalized))
    .slice(0, 8)

  return (
    <div className="command-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label={t('secretary.search')}>
        <BeuiInput
          ref={inputRef}
          className="command-search"
          leftIcon={<Search size={17} aria-hidden="true" />}
          rightIcon={<button type="button" aria-label={t('common.close')} onClick={onClose}><X size={15} /></button>}
          type="search"
          value={query}
          placeholder={t('secretary.searchPlaceholder')}
          onChange={setQuery}
        />
        <div className="command-results">
          <button className="command-command" type="button" onClick={onOpenTasks}>
            <span className="command-icon"><Inbox size={15} /></span>
            <span>
              <strong>{t('secretary.openNeedsYou')}</strong>
              <small>{t('secretary.openNeedsYouDetail')}</small>
            </span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
          {results.map((task) => (
            <button className="command-command" type="button" key={task.id} onClick={() => onOpenTask(task)}>
              <span className="command-icon"><Inbox size={15} /></span>
              <span>
                <strong>{task.title}</strong>
                <small>{task.detail ?? t(`tasks.status.${task.status}`)}</small>
              </span>
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          ))}
          {results.length === 0 && normalized !== '' && (
            <p className="command-empty">{t('secretary.noMatches')}</p>
          )}
        </div>
      </section>
    </div>
  )
}
