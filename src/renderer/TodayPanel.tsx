import { ArrowRight, Sparkles, UserRound } from 'lucide-react'
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
  const routines = [...needsYou, ...active].slice(0, 6)
  const routineGroups = [
    { origin: 'automation' as const, tasks: routines.filter((task) => task.origin === 'automation') },
    { origin: 'user' as const, tasks: routines.filter((task) => task.origin === 'user') },
  ].filter((group) => group.tasks.length > 0)
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

      <button className="today-brief-link" type="button" onClick={onOpenTasks}>
        <span>{needsYou.length > 0 ? t('secretary.needsYouCount', { count: needsYou.length }) : t('secretary.nothingWaiting')}</span>
        <ArrowRight size={13} aria-hidden="true" />
      </button>

      <section className="today-routines" aria-labelledby="today-routines-title">
        <div className="today-section-heading">
          <h2 id="today-routines-title">{t('secretary.routines')}</h2>
          <span>{routines.length}</span>
        </div>
        {routineGroups.length === 0 ? (
          <div className="today-empty">
            <Sparkles size={16} aria-hidden="true" />
            <p>{t('secretary.routinesEmpty')}</p>
          </div>
        ) : (
          <div className="routine-group-list">
            {routineGroups.map((group) => (
              <section className="routine-group" key={group.origin} aria-label={group.origin === 'automation' ? t('secretary.automation') : t('secretary.you')}>
                <header className="routine-group-heading">
                  <span className={`routine-provider-mark routine-provider-${group.origin}`} aria-hidden="true">
                    {group.origin === 'automation' ? <Sparkles size={14} /> : <UserRound size={14} />}
                  </span>
                  <strong>{group.origin === 'automation' ? t('secretary.automation') : t('secretary.you')}</strong>
                  <span>{group.tasks.length}</span>
                </header>
                <div className="routine-group-actions">
                  {group.tasks.map((task) => (
                    <button className="routine-row" type="button" key={task.id} onClick={onOpenTasks}>
                      <span className="routine-copy">
                        <strong>{task.title}</strong>
                        {task.detail !== undefined && <small>{task.detail}</small>}
                      </span>
                      <span className={`routine-state routine-state-${task.status}`}>{t(`tasks.status.${task.status}`)}</span>
                    </button>
                  ))}
                </div>
              </section>
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

