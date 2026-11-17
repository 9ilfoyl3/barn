import { ArrowUpRight, Inbox, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task } from '../shared/models'

export interface TodayPanelProps {
  tasks: Task[]
  onOpenTasks: () => void
}

export function TodayPanel({ tasks, onOpenTasks }: TodayPanelProps) {
  const { t, i18n } = useTranslation()
  const now = new Date()
  const greeting = now.getHours() < 12
    ? t('secretary.goodMorning')
    : now.getHours() < 18
      ? t('secretary.goodAfternoon')
      : t('secretary.goodEvening')
  const needsYou = tasks.filter((task) => ['proposed', 'waiting', 'failed'].includes(task.status))
  const active = tasks.filter((task) => ['queued', 'running'].includes(task.status))
  const routines = [...needsYou, ...active].slice(0, 5)
  const summary = needsYou.length > 0
    ? t('secretary.summaryNeedsYou', { count: needsYou.length })
    : active.length > 0
      ? t('secretary.summaryActive', { count: active.length })
      : t('secretary.summaryClear')

  return (
    <section className="today-panel" aria-label={t('secretary.today')}>
      <header className="today-intro">
        <p className="today-date">{formatDate(now, i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US')}</p>
        <h1>{greeting}</h1>
        <p>{summary}</p>
      </header>

      <button className="today-attention" type="button" onClick={onOpenTasks}>
        <span className="today-attention-icon" aria-hidden="true"><Inbox size={15} /></span>
        <span>
          <strong>{t('secretary.needsYou')}</strong>
          <small>{needsYou.length > 0 ? t('secretary.needsYouCount', { count: needsYou.length }) : t('secretary.nothingWaiting')}</small>
        </span>
        <span className="today-attention-count">{needsYou.length}</span>
      </button>

      <section className="today-routines" aria-labelledby="today-routines-title">
        <div className="today-section-heading">
          <h2 id="today-routines-title">{t('secretary.routines')}</h2>
          <span>{routines.length}</span>
        </div>
        {routines.length === 0 ? (
          <div className="today-empty">
            <Sparkles size={16} aria-hidden="true" />
            <p>{t('secretary.routinesEmpty')}</p>
          </div>
        ) : (
          <div className="routine-list">
            {routines.map((task) => (
              <button className="routine-card" type="button" key={task.id} onClick={onOpenTasks}>
                <span className={`routine-status routine-status-${task.status}`} aria-hidden="true" />
                <span className="routine-copy">
                  <strong>{task.title}</strong>
                  <small>{task.detail ?? t(`tasks.status.${task.status}`)}</small>
                </span>
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}


function formatDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric' }).format(date)
}

