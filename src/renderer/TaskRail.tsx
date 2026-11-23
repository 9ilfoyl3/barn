import { Bookmark, CircleCheck, CircleX, ListTodo, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Task, TaskStatus } from '../shared/models'

export type TaskRailFilter = 'active' | 'review' | 'completed' | 'cancelled'

export interface TaskRailProps {
  tasks: Task[]
  onOpenTask: (task: Task) => void
  onOpenTasks: () => void
}

const TASK_RAIL_FILTERS: readonly TaskRailFilter[] = ['active', 'review', 'completed', 'cancelled']

const FILTER_STATUSES: Record<TaskRailFilter, readonly TaskStatus[]> = {
  active: ['queued', 'running'],
  review: ['proposed', 'waiting', 'failed'],
  completed: ['completed'],
  cancelled: ['cancelled'],
}

export function filterTasksForRail(tasks: Task[], filter: TaskRailFilter): Task[] {
  const allowed = FILTER_STATUSES[filter]
  return tasks
    .filter((task) => allowed.includes(task.status))
    .toSorted((left, right) => statusRank(left.status) - statusRank(right.status) || right.updatedAt.localeCompare(left.updatedAt))
}

export function defaultTaskRailFilter(tasks: Task[]): TaskRailFilter {
  for (const filter of TASK_RAIL_FILTERS) {
    if (filterTasksForRail(tasks, filter).length > 0) return filter
  }
  return 'active'
}

export function TaskRail({ tasks, onOpenTask, onOpenTasks }: TaskRailProps) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState<TaskRailFilter>(() => defaultTaskRailFilter(tasks))
  const filterTouched = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollFades, setScrollFades] = useState({ top: false, bottom: false })
  const visibleTasks = useMemo(() => filterTasksForRail(tasks, filter), [filter, tasks])
  const locale = i18n.resolvedLanguage ?? document.documentElement.lang ?? 'zh-CN'

  const updateScrollFades = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    const next = {
      top: element.scrollTop > 2,
      bottom: element.scrollHeight - element.scrollTop - element.clientHeight > 2,
    }
    setScrollFades((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }, [])

  useEffect(() => {
    if (!filterTouched.current) setFilter(defaultTaskRailFilter(tasks))
  }, [tasks])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = 0
    updateScrollFades()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateScrollFades)
    observer?.observe(element)
    const list = element.querySelector('.task-rail-list, .task-rail-filter-empty')
    if (list !== null) observer?.observe(list)
    return () => observer?.disconnect()
  }, [filter, updateScrollFades, visibleTasks.length])

  function selectFilter(next: TaskRailFilter): void {
    filterTouched.current = true
    setFilter(next)
  }

  return (
    <aside className="task-rail" aria-label={t('tasks.title')}>
      <div className="task-rail-heading">
        <h2>{t('secretary.tasksTitle')}</h2>
        <button type="button" onClick={onOpenTasks}>{t('secretary.viewAll')}</button>
      </div>

      <div className="task-rail-scroll-shell">
        <div
          ref={scrollRef}
          className="task-rail-scroll"
          onScroll={updateScrollFades}
        >
          {visibleTasks.length === 0 ? (
            <div className="task-rail-filter-empty" key={filter}>
              <span className="task-rail-filter-empty-mark" aria-hidden="true"><ListTodo size={17} /></span>
              <strong>{t(`secretary.taskFilterEmpty.${filter}`)}</strong>
              <p>{t('secretary.taskFilterEmptyDescription')}</p>
            </div>
          ) : (
            <div className="task-rail-list" key={filter}>
              {visibleTasks.map((task) => {
                const statusLabel = taskStatusLabel(task, t)
                return (
                  <button
                    className={`task-rail-card task-rail-card-${task.status}`}
                    type="button"
                    key={task.id}
                    onClick={() => onOpenTask(task)}
                  >
                    <span className={`task-rail-state task-rail-state-${task.status}`} aria-hidden="true">
                      <TaskStatusIcon status={task.status} />
                    </span>
                    <span className="task-rail-card-main">
                      <strong>{task.title}</strong>
                      <span className="task-rail-tags">
                        <span className={`task-rail-tag task-rail-tag-category task-rail-tag-category-${task.status}`}>
                          <i aria-hidden="true" />
                          {task.kind === 'reminder' ? t('secretary.reminderTag') : t('secretary.workTag')}
                        </span>
                        <span className={`task-rail-tag task-rail-tag-app task-rail-tag-app-${task.origin}`}>
                          <b className="task-rail-app-mark" aria-hidden="true">
                            {task.origin === 'automation' ? 'B' : 'Y'}
                          </b>
                          {task.origin === 'automation' ? t('secretary.automation') : t('secretary.you')}
                        </span>
                      </span>
                      <span className="task-rail-updated">
                        {t('secretary.updatedAt', { date: formatTaskDate(task.updatedAt, locale) })}
                      </span>
                      <span className="visually-hidden">{statusLabel}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <span
          className="task-rail-fade task-rail-fade-top"
          data-visible={scrollFades.top}
          aria-hidden="true"
        />
        <span
          className="task-rail-fade task-rail-fade-bottom"
          data-visible={scrollFades.bottom}
          aria-hidden="true"
        />
      </div>

      <div className="task-rail-filter" role="group" aria-label={t('secretary.taskFilters')}>
        {TASK_RAIL_FILTERS.map((candidate) => {
          const active = candidate === filter
          const label = t(`secretary.taskFilter.${candidate}`)
          return (
            <button
              className={`task-rail-filter-button task-rail-filter-button-${candidate}${active ? ' active' : ''}`}
              type="button"
              key={candidate}
              aria-label={label}
              aria-pressed={active}
              title={label}
              onClick={() => selectFilter(candidate)}
            >
              <span className="task-rail-filter-dot" aria-hidden="true" />
              <span className="task-rail-filter-active-content">
                <TaskFilterIcon filter={candidate} />
                <span>{label}</span>
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function formatTaskDate(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
}

function taskStatusLabel(
  task: Task,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string) => string
  return task.kind === 'reminder' && task.status === 'queued'
    ? translate('secretary.scheduled')
    : translate(`tasks.status.${task.status}`)
}

function TaskStatusIcon({ status }: { status: Task['status'] }) {
  if (status === 'running' || status === 'queued') return <LoaderCircle className="task-rail-spinner" size={16} />
  if (status === 'completed') return <CircleCheck size={16} />
  if (status === 'failed' || status === 'cancelled') return <CircleX size={16} />
  return <ReviewStatusIcon size={16} />
}

function TaskFilterIcon({ filter }: { filter: TaskRailFilter }) {
  if (filter === 'active') return <LoaderCircle className="task-rail-spinner" size={14} aria-hidden="true" />
  if (filter === 'review') return <ReviewStatusIcon size={14} />
  if (filter === 'completed') return <CircleCheck size={14} aria-hidden="true" />
  return <CircleX size={14} aria-hidden="true" />
}

function ReviewStatusIcon({ size }: { size: number }) {
  return (
    <span className="task-review-icon" aria-hidden="true">
      <Bookmark size={size} />
      <span className="task-review-alert">!</span>
    </span>
  )
}

function statusRank(status: Task['status']): number {
  if (status === 'waiting' || status === 'failed' || status === 'proposed') return 0
  if (status === 'running' || status === 'queued') return 1
  if (status === 'completed') return 2
  return 3
}
