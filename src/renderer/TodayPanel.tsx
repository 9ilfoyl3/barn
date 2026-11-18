import { RefreshCw, SlidersHorizontal, Sparkles, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task } from '../shared/models'

export interface TodayPanelProps {
  tasks: Task[]
  onOpenTasks: () => void
  onConnectSources: () => void
  onRefresh: () => void
}

export function TodayPanel({ tasks, onOpenTasks, onConnectSources, onRefresh }: TodayPanelProps) {
  const { t } = useTranslation()
  const needsYou = tasks.filter((task) => ['proposed', 'waiting', 'failed'].includes(task.status))
  const active = tasks.filter((task) => ['queued', 'running'].includes(task.status))
  const routines = [...needsYou, ...active].slice(0, 6)
  const routineGroups = [
    { origin: 'automation' as const, tasks: routines.filter((task) => task.origin === 'automation') },
    { origin: 'user' as const, tasks: routines.filter((task) => task.origin === 'user') },
  ].filter((group) => group.tasks.length > 0)

  return (
    <section className="today-panel" aria-labelledby="today-routines-title">
      <header className="today-panel-heading">
        <h1 id="today-routines-title">{t('secretary.routines')}</h1>
        <div className="today-panel-actions">
          <button type="button" aria-label={t('secretary.refreshRoutines')} onClick={onRefresh}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button type="button" aria-label={t('secretary.viewAll')} onClick={onOpenTasks}>
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="today-panel-body">
        {routineGroups.length === 0 ? (
          <div className="routine-empty-state">
            <span className="routine-empty-mark" aria-hidden="true"><Sparkles size={16} /></span>
            <strong>{t('secretary.routinesEmptyTitle')}</strong>
            <p>{t('secretary.routinesEmpty')}</p>
            <button type="button" onClick={onConnectSources}>{t('secretary.connectApps')}</button>
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
                      <span className={`routine-state routine-state-${task.status}`}>{routineStatusLabel(task, t)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function routineStatusLabel(
  task: Task,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return task.kind === 'reminder' && task.status === 'queued'
    ? t('secretary.scheduled')
    : t(`tasks.status.${task.status}`)
}
