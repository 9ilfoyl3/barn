/* Hallmark · dismissed F4 · the refresh control is a utility action, not a competing primary action */
import { Blocks, CalendarDays, Check, Cloud, Mail, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoutineRecurrence } from '../shared/models'

export interface RoutineFeedItem {
  id: string
  title: string
  body?: string
  recurrence?: RoutineRecurrence
  deliveredAt?: string
}

export interface TodayPanelProps {
  routines: RoutineFeedItem[]
  onAcknowledgeRoutine: (routineId: string) => void
  onConnectSources: () => void
  onOpenRoutine: (routineId: string) => void
  onRefresh: () => void
}

const routineApps = [
  { icon: Blocks, tone: 'accent' },
  { icon: Mail, tone: 'warning' },
  { icon: CalendarDays, tone: 'green' },
  { icon: Cloud, tone: 'link' },
] as const

const routineCardTones = ['accent', 'warning', 'green', 'link'] as const

export function TodayPanel({
  routines,
  onAcknowledgeRoutine,
  onConnectSources,
  onOpenRoutine,
  onRefresh,
}: TodayPanelProps) {
  const { t } = useTranslation()
  const [confirmingRoutineIds, setConfirmingRoutineIds] = useState<Set<string>>(() => new Set())
  const acknowledgementTimers = useRef(new Map<string, number>())
  const hour = new Date().getHours()
  const greeting = hour < 12
    ? t('secretary.goodMorning')
    : hour < 18
      ? t('secretary.goodAfternoon')
      : t('secretary.goodEvening')
  const orderedRoutines = routines.toSorted((left, right) => (
    (right.deliveredAt ?? '').localeCompare(left.deliveredAt ?? '')
  ))

  useEffect(() => () => {
    for (const timer of acknowledgementTimers.current.values()) window.clearTimeout(timer)
    acknowledgementTimers.current.clear()
  }, [])

  function confirmRoutine(routineId: string): void {
    if (acknowledgementTimers.current.has(routineId)) return
    setConfirmingRoutineIds((current) => new Set(current).add(routineId))
    const timer = window.setTimeout(() => {
      onAcknowledgeRoutine(routineId)
      setConfirmingRoutineIds((current) => {
        const next = new Set(current)
        next.delete(routineId)
        return next
      })
      acknowledgementTimers.current.delete(routineId)
    }, 800)
    acknowledgementTimers.current.set(routineId, timer)
  }

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
              const confirming = confirmingRoutineIds.has(routine.id)
              return (
                <article className="routine-card" key={routine.id}>
                  <button
                    className="routine-card-open"
                    type="button"
                    aria-label={t('secretary.openRoutine', { title: routine.title })}
                    onClick={() => onOpenRoutine(routine.id)}
                  />
                  <span className="routine-card-heading">
                    <strong className="routine-card-title">{routine.title}</strong>
                  </span>
                  {routine.body !== undefined && (
                    <span className="routine-card-quote">{routine.body}</span>
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
                  <button
                    className={`routine-card-acknowledge${confirming ? ' is-confirming' : ''}`}
                    type="button"
                    aria-label={t('secretary.acknowledgeRoutine', { title: routine.title })}
                    aria-busy={confirming}
                    aria-disabled={confirming}
                    title={t('secretary.acknowledgeRoutine', { title: routine.title })}
                    onClick={() => confirmRoutine(routine.id)}
                  >
                    <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function routineRecurrenceLabel(
  routine: RoutineFeedItem,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string) => string
  if (routine.recurrence === 'daily') return translate('secretary.recurrenceDaily')
  if (routine.recurrence === 'weekdays') return translate('secretary.recurrenceWeekdays')
  if (routine.recurrence === 'weekly') return translate('secretary.recurrenceWeekly')
  return translate('secretary.routineDelivered')
}
