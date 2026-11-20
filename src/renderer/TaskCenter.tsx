import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import './task-center.css'
import type { Task, TaskStatus } from '../shared/models'

export type TaskGroupKey = 'needsYou' | 'inProgress' | 'recent'

export interface TaskGroups {
  needsYou: Task[]
  inProgress: Task[]
  recent: Task[]
}

const NEEDS_YOU = new Set<TaskStatus>(['proposed', 'waiting', 'failed'])
const IN_PROGRESS = new Set<TaskStatus>(['queued', 'running'])

/** Group tasks by the attention they need, keeping each group in store order. */
export function groupTasks(tasks: Task[]): TaskGroups {
  const groups: TaskGroups = { needsYou: [], inProgress: [], recent: [] }
  for (const task of tasks) {
    if (NEEDS_YOU.has(task.status)) groups.needsYou.push(task)
    else if (IN_PROGRESS.has(task.status)) groups.inProgress.push(task)
    else groups.recent.push(task)
  }
  return groups
}

export interface TaskCenterProps {
  tasks: Task[]
  loading: boolean
  error?: string | undefined
  onOpenTask(task: Task): void
  onError(message: string | undefined): void
}

/** The personal Agent's attention inbox: work that needs a person, work in progress, and recent outcomes. */
export function TaskCenter({ tasks, loading, error, onOpenTask, onError }: TaskCenterProps) {
  const { t, i18n } = useTranslation()
  const dateLocale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'
  const [busyTaskId, setBusyTaskId] = useState<string>()
  const [editingTaskId, setEditingTaskId] = useState<string>()
  const [draftPrompt, setDraftPrompt] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const groups = groupTasks(tasks)
  const total = tasks.length

  useEffect(() => {
    if (editingTaskId !== undefined) editorRef.current?.focus()
  }, [editingTaskId])

  async function updateStatus(task: Task, status: TaskStatus): Promise<void> {
    setBusyTaskId(task.id)
    onError(undefined)
    try {
      await window.barn.tasks.updateStatus(task.id, { status })
      if (status === 'cancelled') setEditingTaskId(undefined)
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusyTaskId(undefined)
    }
  }

  async function resolveApproval(task: Task, decision: 'approved' | 'denied'): Promise<void> {
    if (task.approvalId === undefined) {
      await updateStatus(task, decision === 'approved' ? 'queued' : 'cancelled')
      return
    }
    setBusyTaskId(task.id)
    onError(undefined)
    try {
      await window.barn.approvals.resolve(task.approvalId, decision)
      if (decision === 'denied') setEditingTaskId(undefined)
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusyTaskId(undefined)
    }
  }

  function editInstructions(task: Task): void {
    setEditingTaskId(task.id)
    setDraftPrompt(task.prompt ?? '')
  }

  async function saveInstructions(task: Task): Promise<void> {
    const prompt = draftPrompt.trim()
    if (prompt.length === 0) return
    setBusyTaskId(task.id)
    onError(undefined)
    try {
      await window.barn.tasks.updatePrompt(task.id, prompt)
      await window.barn.tasks.updateStatus(task.id, { status: 'queued' })
      setEditingTaskId(undefined)
      setDraftPrompt('')
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusyTaskId(undefined)
    }
  }

  if (loading && total === 0) {
    return (
      <section className="task-center" aria-busy="true" aria-label={t('tasks.loading')}>
        <div className="task-loading">
          <span />
          <span />
          <span />
        </div>
      </section>
    )
  }

  if (total === 0) {
    return (
      <section className="task-center task-center-empty" aria-label={t('tasks.title')}>
        <div className="task-empty-mark" aria-hidden="true"><Inbox size={21} /></div>
        <h2>{t('tasks.emptyTitle')}</h2>
        <p>{t('tasks.emptyBody')}</p>
        {error !== undefined && <div className="error-banner task-error" role="alert">{error}</div>}
      </section>
    )
  }

  return (
    <section className="task-center" aria-label={t('tasks.title')}>
      <p className="task-center-summary">
        {groups.needsYou.length === 0
          ? t('tasks.summaryClear')
          : t('tasks.summaryNeedsYou', { count: groups.needsYou.length })}
      </p>
      {error !== undefined && <div className="error-banner task-error" role="alert">{error}</div>}
      <TaskGroup
        groupKey="needs-you"
        title={t('tasks.needsYou')}
        tasks={groups.needsYou}
        busyTaskId={busyTaskId}
        editingTaskId={editingTaskId}
        draftPrompt={draftPrompt}
        editorRef={editorRef}
        dateLocale={dateLocale}
        onDraftPrompt={setDraftPrompt}
        onEdit={editInstructions}
        onCancelEdit={() => {
          setEditingTaskId(undefined)
          setDraftPrompt('')
        }}
        onSave={saveInstructions}
        onStatus={updateStatus}
        onResolveApproval={resolveApproval}
        onOpenTask={onOpenTask}
      />
      <TaskGroup
        groupKey="in-progress"
        title={t('tasks.inProgress')}
        tasks={groups.inProgress}
        busyTaskId={busyTaskId}
        editingTaskId={editingTaskId}
        draftPrompt={draftPrompt}
        editorRef={editorRef}
        dateLocale={dateLocale}
        onDraftPrompt={setDraftPrompt}
        onEdit={editInstructions}
        onCancelEdit={() => setEditingTaskId(undefined)}
        onSave={saveInstructions}
        onStatus={updateStatus}
        onResolveApproval={resolveApproval}
        onOpenTask={onOpenTask}
      />
      <TaskGroup
        groupKey="recent"
        title={t('tasks.recent')}
        tasks={groups.recent}
        busyTaskId={busyTaskId}
        editingTaskId={editingTaskId}
        draftPrompt={draftPrompt}
        editorRef={editorRef}
        dateLocale={dateLocale}
        onDraftPrompt={setDraftPrompt}
        onEdit={editInstructions}
        onCancelEdit={() => setEditingTaskId(undefined)}
        onSave={saveInstructions}
        onStatus={updateStatus}
        onResolveApproval={resolveApproval}
        onOpenTask={onOpenTask}
      />
    </section>
  )
}

interface TaskGroupProps {
  groupKey: string
  title: string
  tasks: Task[]
  busyTaskId?: string | undefined
  editingTaskId?: string | undefined
  draftPrompt: string
  editorRef: RefObject<HTMLTextAreaElement | null>
  dateLocale: string
  onDraftPrompt(value: string): void
  onEdit(task: Task): void
  onCancelEdit(): void
  onSave(task: Task): Promise<void>
  onStatus(task: Task, status: TaskStatus): Promise<void>
  onResolveApproval(task: Task, decision: 'approved' | 'denied'): Promise<void>
  onOpenTask(task: Task): void
}

function TaskGroup(props: TaskGroupProps) {
  if (props.tasks.length === 0) return null
  return (
    <section className="task-group" aria-labelledby={`task-group-${props.groupKey}`}>
      <div className="task-group-heading">
        <h2 id={`task-group-${props.groupKey}`}>{props.title}</h2>
        <span>{props.tasks.length}</span>
      </div>
      <div className="task-list">
        {props.tasks.map((task) => (
          <TaskRow key={task.id} task={task} {...props} />
        ))}
      </div>
    </section>
  )
}

function TaskRow({
  task,
  busyTaskId,
  editingTaskId,
  draftPrompt,
  editorRef,
  dateLocale,
  onDraftPrompt,
  onEdit,
  onCancelEdit,
  onSave,
  onStatus,
  onResolveApproval,
  onOpenTask,
}: TaskGroupProps & { task: Task }) {
  const { t } = useTranslation()
  const busy = busyTaskId === task.id
  const editing = editingTaskId === task.id
  const needsInstructions = (task.status === 'waiting' && task.waitingReason === 'input')
    || ((task.status === 'proposed' || task.status === 'failed') && task.prompt === undefined)
  const detail = task.detail ?? t(`tasks.statusDetail.${task.status}`)

  return (
    <article className="task-row" aria-busy={busy}>
      <div className="task-row-copy">
        <div className="task-row-title">
          <button type="button" className="task-row-title-button" aria-label={`${t('tasks.openDetails')}: ${task.title}`} onClick={() => onOpenTask(task)}><h3>{task.title}</h3></button>
          <span className={`task-status task-status-${task.status}`}>{t(`tasks.status.${task.status}`)}</span>
        </div>
        <p>{detail}</p>
        <time dateTime={task.updatedAt}>{formatTaskTime(task.updatedAt, dateLocale)}</time>
      </div>
      <div className="task-row-actions">
        <button type="button" className="task-action" onClick={() => onOpenTask(task)}>
          {t('tasks.openDetails')}
        </button>
        {task.status === 'proposed' && task.prompt !== undefined && (
          <button type="button" className="task-action primary" disabled={busy} onClick={() => void onStatus(task, 'queued')}>
            {t('tasks.run')}
          </button>
        )}
        {task.status === 'waiting' && task.waitingReason === 'approval' && (
          <button type="button" className="task-action primary" disabled={busy} onClick={() => void onResolveApproval(task, 'approved')}>
            {t('tasks.approve')}
          </button>
        )}
        {task.status === 'waiting' && task.waitingReason === 'review' && (
          <button type="button" className="task-action primary" disabled={busy} onClick={() => void onStatus(task, 'completed')}>
            {t('tasks.markComplete')}
          </button>
        )}
        {task.status === 'failed' && task.prompt !== undefined && (
          <button type="button" className="task-action primary" disabled={busy} onClick={() => void onStatus(task, 'queued')}>
            {t('tasks.retry')}
          </button>
        )}
        {needsInstructions && (
          <button type="button" className="task-action primary" disabled={busy} onClick={() => onEdit(task)}>
            {t('tasks.addInstructions')}
          </button>
        )}
        {(task.status === 'proposed' || task.status === 'waiting' || task.status === 'failed') && (
          <button type="button" className="task-action quiet" disabled={busy} onClick={() => void (task.approvalId === undefined ? onStatus(task, 'cancelled') : onResolveApproval(task, 'denied'))}>
            {t('tasks.dismiss')}
          </button>
        )}
        {(task.status === 'queued' || task.status === 'running') && (
          <button type="button" className="task-action quiet" disabled={busy} onClick={() => void onStatus(task, 'cancelled')}>
            {t('tasks.cancel')}
          </button>
        )}
      </div>
      {editing && (
        <form
          className="task-instructions"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave(task)
          }}
        >
          <textarea
            ref={editorRef}
            aria-label={t('tasks.instructionsLabel')}
            placeholder={t('tasks.instructionsPlaceholder')}
            value={draftPrompt}
            onChange={(event) => onDraftPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onCancelEdit()
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void onSave(task)
              }
            }}
            rows={3}
          />
          <div className="task-instructions-actions">
            <button type="button" className="task-action quiet" onClick={onCancelEdit}>{t('common.cancel')}</button>
            <button type="submit" className="task-action primary" disabled={busy || draftPrompt.trim().length === 0}>
              {t('tasks.saveAndRun')}
            </button>
          </div>
        </form>
      )}
    </article>
  )
}

function formatTaskTime(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
