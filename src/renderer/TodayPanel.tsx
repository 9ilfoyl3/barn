/* Hallmark · dismissed F4 · the refresh control is a utility action, not a competing primary action */
import { Blocks, CalendarDays, Cloud, Mail, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task } from '../shared/models'

export interface TodayPanelProps {
  routines: Task[]
  onOpenRoutine: (routine: Task) => void
  onConnectSources: () => void
  onRefresh: () => void
}

const routineApps = [
  { icon: Blocks, tone: 'accent' },
  { icon: Mail, tone: 'warning' },
  { icon: CalendarDays, tone: 'green' },
  { icon: Cloud, tone: 'link' },
] as const

const routineCardTones = ['accent', 'warning', 'green', 'link'] as const

export function TodayPanel({ routines, onOpenRoutine, onConnectSources, onRefresh }: TodayPanelProps) {
  const { t } = useTranslation()
  const hour = new Date().getHours()
  const greeting = hour < 12
    ? t('secretary.goodMorning')
    : hour < 18
      ? t('secretary.goodAfternoon')
      : t('secretary.goodEvening')
  const orderedRoutines = routines.toSorted((left, right) => (
    (left.scheduledFor ?? left.updatedAt).localeCompare(right.scheduledFor ?? right.updatedAt)
  ))

  return (
    <section className="today-panel routine-home-panel" aria-labelledby="today-routines-title">
      <header className="routines-header">
        <div className="routines-heading-copy">
          <h1 id="today-routines-title">{greeting}</h1>
          <p>{t('secretary.routineCount', { count: orderedRoutines.length })}</p>
        </div>
        <button type="button" aria-label={t('secretary.refreshRoutines')} title={t('secretary.refreshRoutines')} onClick={onRefresh}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="today-panel-body routine-home-body">
        {orderedRoutines.length === 0 ? (
          <div className="routine-empty-state routine-home-empty">
            <div className="routine-app-stack" aria-hidden="true">
              {routineApps.map(({ icon: Icon, tone }) => (
                <span className={`routine-app-token routine-app-token-${tone}`} key={tone}>
                  <Icon size={14} />
                </span>
              ))}
            </div>
            <strong>{t('secretary.routinesEmptyTitle')}</strong>
            <p>{t('secretary.routinesEmptyDescription')}</p>
            <button type="button" onClick={onConnectSources}>{t('secretary.connectApps')}</button>
          </div>
        ) : (
          <div className="routine-card-list">
            {orderedRoutines.map((routine, index) => {
              const tone = routineCardTones[index % routineCardTones.length]
              return (
                <button
                  className="routine-card"
                  type="button"
                  key={routine.id}
                  onClick={() => onOpenRoutine(routine)}
                >
                  <span className="routine-card-heading">
                    <strong className="routine-card-title">{routine.title}</strong>
                  </span>
                  {routine.visiblePrompt !== undefined && (
                    <span className="routine-card-quote">{routine.visiblePrompt}</span>
                  )}
                  <span className="routine-card-tags">
                    <span className={`routine-card-tag routine-card-tag-${tone}`}>
                      <i aria-hidden="true" />
                      {routineRecurrenceLabel(routine, t)}
                    </span>
                    <span className="routine-card-tag routine-card-tag-app">
                      <b className="routine-card-app-mark" aria-hidden="true">B</b>
                      {t('secretary.routineProvider')}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function routineRecurrenceLabel(
  routine: Task,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (routine.recurrence === 'daily') return t('secretary.recurrenceDaily')
  if (routine.recurrence === 'weekdays') return t('secretary.recurrenceWeekdays')
  if (routine.recurrence === 'weekly') return t('secretary.recurrenceWeekly')
  return t('secretary.scheduled')
}
