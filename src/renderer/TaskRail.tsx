import { AlertCircle, Check, Circle, ListTodo, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task } from '../shared/models'

export interface TaskRailProps {
  tasks: Task[]
  onOpenTask: (task: Task) => void
  onOpenTasks: () => void
}

export function TaskRail({ tasks, onOpenTask, onOpenTasks }: TaskRailProps) {
  const { t } = useTranslation()
  const ordered = tasks
    .filter((task) => task.status !== 'cancelled')
    .toSorted((left, right) => statusRank(left.status) - statusRank(right.status) || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 7)

  return (
    <aside className="task-rail" aria-label={t('tasks.title')}>
      <div className="task-rail-heading">
        <h2>{t('secretary.tasksTitle')}</h2>
        <button type="button" onClick={onOpenTasks}>{t('secretary.viewAll')}</button>
      </div>
      {ordered.length === 0 ? (
        <div className="task-rail-empty">
          <span className="task-rail-empty-mark" aria-hidden="true"><ListTodo size={17} /></span>
          <strong>{t('secretary.noTasksTitle')}</strong>
          <p>{t('secretary.tasksEmptyDescription')}</p>
        </div>
      ) : (
        <div className="task-rail-list">
          {ordered.map((task) => (
            <button className="task-rail-card" type="button" key={task.id} onClick={() => onOpenTask(task)}>
              <span className={`task-rail-state task-rail-state-${task.status}`} aria-hidden="true">
                <TaskStatusIcon status={task.status} />
              </span>
              <span className="task-rail-copy">
                <strong>{task.title}</strong>
                {task.detail !== undefined && <small>{task.detail}</small>}
                <span className="task-rail-meta">
                  <span>{task.origin === 'automation' ? t('secretary.automation') : t('secretary.you')}</span>
                  <span>{t(`tasks.status.${task.status}`)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

function TaskStatusIcon({ status }: { status: Task['status'] }) {
  if (status === 'running' || status === 'queued') return <LoaderCircle className="task-rail-spinner" size={15} />
  if (status === 'completed') return <Check size={15} />
  if (status === 'failed') return <X size={15} />
  if (status === 'waiting') return <AlertCircle size={15} />
  return <Circle size={13} />
}

function statusRank(status: Task['status']): number {
  if (status === 'waiting' || status === 'failed' || status === 'proposed') return 0
  if (status === 'running' || status === 'queued') return 1
  if (status === 'completed') return 2
  return 3
}
