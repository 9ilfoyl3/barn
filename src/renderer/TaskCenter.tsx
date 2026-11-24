import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleX,
  Inbox,
  LoaderCircle,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import './task-center.css'
import type { ApprovalRequest, ConnectorActionSummary, Task, TaskStatus } from '../shared/models'
import { useErrorToast } from './notifications'
import { TaskApprovalCard } from './TaskApprovalCard'

export type TaskGroupKey = 'needsYou' | 'inProgress' | 'recent'

export interface TaskGroups {
  needsYou: Task[]
  inProgress: Task[]
  recent: Task[]
}

export type TaskBoardFilter = 'all' | 'needsYou' | 'inProgress' | 'completed' | 'cancelled'

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
  approvals: ApprovalRequest[]
  loading: boolean
  error?: string | undefined
  onOpenTask(task: Task): void
  onRefresh(): void
  onError(message: string | undefined): void
}

/** Comma-style task workspace: a board of status columns with task cards. */
export function TaskCenter({ tasks, approvals, loading, error, onOpenTask, onRefresh, onError }: TaskCenterProps) {
  const { t, i18n } = useTranslation()
  const dateLocale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'
  const [busyTaskId, setBusyTaskId] = useState<string>()
  const [editingTaskId, setEditingTaskId] = useState<string>()
  const [draftPrompt, setDraftPrompt] = useState('')
  const [connectorActions, setConnectorActions] = useState<ConnectorActionSummary[]>([])
  const [busyApprovalId, setBusyApprovalId] = useState<string>()
  const [busyConnectorActionId, setBusyConnectorActionId] = useState<string>()
  const [filter, setFilter] = useState<TaskBoardFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createPrompt, setCreatePrompt] = useState('')
  const [creating, setCreating] = useState(false)
  useErrorToast(error)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const createPromptRef = useRef<HTMLTextAreaElement>(null)
  const groups = groupTasks(tasks)
  const completed = groups.recent.filter((task) => task.status === 'completed')
  const cancelled = groups.recent.filter((task) => task.status === 'cancelled')
  const recentConnectorActions = connectorActions.filter((action) => action.status !== 'pending_approval')
  const attentionConnectorActions = recentConnectorActions.filter((action) => action.status === 'unknown_effect')
  const showConnectorActions = approvals.length > 0 || recentConnectorActions.length > 0
  const needsYouCount = groups.needsYou.length + approvals.length + attentionConnectorActions.length

  useEffect(() => {
    if (editingTaskId !== undefined) editorRef.current?.focus()
  }, [editingTaskId])

  useEffect(() => {
    if (createOpen) createPromptRef.current?.focus()
  }, [createOpen])

  useEffect(() => {
    if (!filterOpen) return
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && filterRef.current?.contains(event.target) === true) return
      setFilterOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [filterOpen])

  useEffect(() => {
    if (!createOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCreateOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [createOpen])

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const actions = await window.barn.connectors.listActions()
        if (active) setConnectorActions(actions)
      } catch {
        // Connector actions are auxiliary; task attention must remain usable if their status cannot load.
      }
    }
    void load()
    const timer = setInterval(() => void load(), 3_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

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

  async function retryConnectorAction(action: ConnectorActionSummary): Promise<void> {
    setBusyConnectorActionId(action.id)
    onError(undefined)
    try {
      await window.barn.connectors.retryAction(action.id)
      setConnectorActions(await window.barn.connectors.listActions())
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusyConnectorActionId(undefined)
    }
  }

  async function cancelConnectorAction(action: ConnectorActionSummary): Promise<void> {
    setBusyConnectorActionId(action.id)
    onError(undefined)
    try {
      await window.barn.connectors.cancelAction(action.id)
      setConnectorActions(await window.barn.connectors.listActions())
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusyConnectorActionId(undefined)
    }
  }

  async function resolveConnectorApproval(approval: ApprovalRequest, decision: 'approved' | 'denied'): Promise<void> {
    setBusyApprovalId(approval.id)
    onError(undefined)
    try {
      await window.barn.approvals.resolve(approval.id, decision)
      setTimeout(() => {
        void window.barn.connectors.listActions().then(setConnectorActions).catch(() => undefined)
      }, 500)
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusyApprovalId(undefined)
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

  async function createTask(): Promise<void> {
    const prompt = createPrompt.trim()
    if (prompt.length === 0) return
    setCreating(true)
    onError(undefined)
    try {
      const task = await window.barn.tasks.create({
        title: createTitle.trim() || taskTitleFromPrompt(prompt),
        origin: 'user',
        status: 'queued',
        prompt,
        visiblePrompt: prompt,
      })
      setCreateOpen(false)
      setCreateTitle('')
      setCreatePrompt('')
      onOpenTask(task)
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setCreating(false)
    }
  }

  const filterLabel = (value: TaskBoardFilter): string => {
    if (value === 'all') return t('tasks.allTasks')
    if (value === 'needsYou') return t('tasks.needsYou')
    if (value === 'inProgress') return t('tasks.inProgress')
    if (value === 'completed') return t('tasks.status.completed')
    return t('tasks.status.cancelled')
  }
  const filterOptions: Array<{ value: TaskBoardFilter; count: number }> = [
    { value: 'all', count: tasks.length },
    { value: 'needsYou', count: needsYouCount },
    { value: 'inProgress', count: groups.inProgress.length },
    { value: 'completed', count: completed.length },
    { value: 'cancelled', count: cancelled.length },
  ]
  const visibleColumns: Array<{
    key: Exclude<TaskBoardFilter, 'all'>
    title: string
    icon: ReactNode
    tasks: Task[]
  }> = []
  if ((filter === 'all' && (needsYouCount > 0 || showConnectorActions)) || filter === 'needsYou') {
    visibleColumns.push({
      key: 'needsYou',
      title: t('tasks.needsYou'),
      icon: <CircleAlert size={16} aria-hidden="true" />,
      tasks: groups.needsYou,
    })
  }
  if (filter === 'all' || filter === 'inProgress') {
    visibleColumns.push({
      key: 'inProgress',
      title: t('tasks.inProgress'),
      icon: <LoaderCircle className="task-column-spinner" size={16} aria-hidden="true" />,
      tasks: groups.inProgress,
    })
  }
  if (filter === 'all' || filter === 'completed') {
    visibleColumns.push({
      key: 'completed',
      title: t('tasks.status.completed'),
      icon: <CircleCheck size={16} aria-hidden="true" />,
      tasks: completed,
    })
  }
  if ((filter === 'all' && cancelled.length > 0) || filter === 'cancelled') {
    visibleColumns.push({
      key: 'cancelled',
      title: t('tasks.status.cancelled'),
      icon: <CircleX size={16} aria-hidden="true" />,
      tasks: cancelled,
    })
  }

  const hasContent = tasks.length > 0 || approvals.length > 0 || connectorActions.length > 0
  const showEmpty = !loading && !hasContent

  return (
    <section className="task-center" aria-label={t('tasks.title')}>
      <header className="task-center-header">
        <h1>{filterLabel(filter)}</h1>
        <div className="task-center-toolbar">
          <div className="task-filter-wrap" ref={filterRef}>
            <button
              aria-expanded={filterOpen}
              aria-haspopup="menu"
              aria-label={t('tasks.filterTasks')}
              className={filterOpen ? 'task-toolbar-button active' : 'task-toolbar-button'}
              onClick={() => setFilterOpen((current) => !current)}
              type="button"
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
            </button>
            {filterOpen && (
              <div className="task-filter-menu" role="menu" aria-label={t('tasks.filterTasks')}>
                {filterOptions.map((option) => (
                  <button
                    aria-checked={filter === option.value}
                    className="task-filter-option"
                    key={option.value}
                    onClick={() => {
                      setFilter(option.value)
                      setFilterOpen(false)
                    }}
                    role="menuitemradio"
                    type="button"
                  >
                    <span>{filterLabel(option.value)}</span>
                    <span>{option.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            aria-label={t('tasks.refreshTasks')}
            className="task-toolbar-button"
            disabled={loading}
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw className={loading ? 'task-toolbar-spin' : undefined} size={16} aria-hidden="true" />
          </button>
          <button className="task-create-button" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={15} aria-hidden="true" />
            {t('tasks.newTask')}
          </button>
        </div>
      </header>

      <div className="task-center-board-shell">
        {loading && !hasContent ? (
          <div className="task-board task-board-loading" aria-busy="true" aria-label={t('tasks.loading')}>
            {[0, 1].map((column) => (
              <section className="task-column" key={column}>
                <div className="task-column-header"><span className="task-loading-title" /></div>
                <div className="task-column-body">
                  {[0, 1, 2].map((card) => <span className="task-loading-card" key={card} />)}
                </div>
              </section>
            ))}
          </div>
        ) : showEmpty ? (
          <div className="task-center-empty">
            <div className="task-empty-mark" aria-hidden="true"><Inbox size={22} /></div>
            <h2>{t('tasks.emptyTitle')}</h2>
            <p>{t('tasks.emptyBody')}</p>
            <button className="task-create-button" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={15} aria-hidden="true" />
              {t('tasks.newTask')}
            </button>
          </div>
        ) : (
          <div className="task-board">
            {visibleColumns.map((column) => (
              <section
                className={`task-column task-column-${column.key}`}
                data-column={column.key}
                key={column.key}
                aria-labelledby={`task-column-${column.key}`}
              >
                <header className="task-column-header">
                  <span className={`task-column-icon task-column-icon-${column.key}`}>{column.icon}</span>
                  <h2 id={`task-column-${column.key}`}>{column.title}</h2>
                  <span className="task-column-count">
                    {column.tasks.length + (column.key === 'needsYou' ? approvals.length + attentionConnectorActions.length : 0)}
                  </span>
                </header>
                <div className="task-column-body">
                  {column.key === 'needsYou' && showConnectorActions && (
                    <ConnectorActionSection
                      actions={connectorActions}
                      approvals={approvals}
                      busyApprovalId={busyApprovalId}
                      busyActionId={busyConnectorActionId}
                      dateLocale={dateLocale}
                      onResolve={resolveConnectorApproval}
                      onRetryAction={retryConnectorAction}
                      onCancelAction={cancelConnectorAction}
                    />
                  )}
                  {column.tasks.map((task) => (
                    <TaskCard
                      busyTaskId={busyTaskId}
                      dateLocale={dateLocale}
                      draftPrompt={draftPrompt}
                      editingTaskId={editingTaskId}
                      editorRef={editorRef}
                      key={task.id}
                      onCancelEdit={() => {
                        setEditingTaskId(undefined)
                        setDraftPrompt('')
                      }}
                      onDraftPrompt={setDraftPrompt}
                      onEdit={editInstructions}
                      onOpenTask={onOpenTask}
                      onResolveApproval={resolveApproval}
                      onSave={saveInstructions}
                      onStatus={updateStatus}
                      task={task}
                    />
                  ))}
                  {column.tasks.length === 0 && !(column.key === 'needsYou' && showConnectorActions) && (
                    <p className="task-column-empty">{t('tasks.columnEmpty')}</p>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {createOpen && (
        <div className="task-dialog-backdrop" role="presentation" onMouseDown={() => setCreateOpen(false)}>
          <form
            aria-label={t('tasks.newTask')}
            aria-modal="true"
            className="task-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              void createTask()
            }}
            role="dialog"
          >
            <header className="task-dialog-header">
              <div>
                <span>{t('tasks.newTaskKicker')}</span>
                <h2>{t('tasks.newTask')}</h2>
              </div>
              <button className="task-dialog-close" type="button" aria-label={t('common.close')} onClick={() => setCreateOpen(false)}>
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <label>
              <span>{t('tasks.newTaskTitle')}</span>
              <input
                autoFocus
                maxLength={200}
                placeholder={t('tasks.newTaskTitlePlaceholder')}
                value={createTitle}
                onChange={(event) => setCreateTitle(event.target.value)}
              />
            </label>
            <label>
              <span>{t('tasks.newTaskInstructions')}</span>
              <textarea
                ref={createPromptRef}
                required
                placeholder={t('tasks.newTaskInstructionsPlaceholder')}
                rows={6}
                value={createPrompt}
                onChange={(event) => setCreatePrompt(event.target.value)}
              />
            </label>
            <div className="task-dialog-actions">
              <button className="task-action quiet" type="button" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</button>
              <button className="task-action primary" type="submit" disabled={creating || createPrompt.trim().length === 0}>
                {creating ? <LoaderCircle className="task-toolbar-spin" size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                {t('tasks.createTask')}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

function ConnectorActionSection({
  actions,
  approvals,
  busyApprovalId,
  busyActionId,
  dateLocale,
  onResolve,
  onRetryAction,
  onCancelAction,
}: {
  actions: ConnectorActionSummary[]
  approvals: ApprovalRequest[]
  busyApprovalId?: string | undefined
  busyActionId?: string | undefined
  dateLocale: string
  onResolve(approval: ApprovalRequest, decision: 'approved' | 'denied'): Promise<void>
  onRetryAction(action: ConnectorActionSummary): Promise<void>
  onCancelAction(action: ConnectorActionSummary): Promise<void>
}) {
  const { t } = useTranslation()
  const recentActions = actions.filter((action) => action.status !== 'pending_approval')
  if (approvals.length === 0 && recentActions.length === 0) return null
  return (
    <section className="connector-action-group" aria-labelledby="task-group-connector-actions">
      <div className="task-column-subheading">
        <h3 id="task-group-connector-actions">{t('tasks.connectorActions')}</h3>
        <span>{approvals.length + recentActions.length}</span>
      </div>
      {approvals.map((approval) => {
        const busy = busyApprovalId === approval.id
        return (
          <article className="task-row connector-action-card task-approval-card-row" key={approval.id}>
            <TaskApprovalCard
              approval={approval}
              busy={busy}
              onResolve={(decision) => void onResolve(approval, decision)}
            />
            <time dateTime={approval.createdAt}>{updatedLabel(approval.createdAt, dateLocale, t)}</time>
          </article>
        )
      })}
      {recentActions.map((action) => (
        <article className="task-row connector-action-card" key={action.id}>
          <div className="connector-action-card-heading">
            <span className="task-card-title">{action.title}</span>
            <span className={`task-status connector-action-status-${action.status}`}>
              {t(`tasks.connectorActionStatus.${action.status}`)}
            </span>
          </div>
          <p>{action.summary}</p>
          {action.lastError !== undefined && <small className="connector-action-error">{action.lastError}</small>}
          <time dateTime={action.updatedAt}>{updatedLabel(action.updatedAt, dateLocale, t)}</time>
          {action.status === 'unknown_effect' && (
            <div className="task-card-actions">
              <button className="task-action quiet" type="button" disabled={busyActionId === action.id} onClick={() => void onCancelAction(action)}>
                {t('tasks.dismiss')}
              </button>
              <button className="task-action primary" type="button" disabled={busyActionId === action.id} onClick={() => void onRetryAction(action)}>
                {t('tasks.retry')}
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  )
}

interface TaskCardProps {
  task: Task
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

function TaskCard({
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
}: TaskCardProps) {
  const { t } = useTranslation()
  const busy = busyTaskId === task.id
  const editing = editingTaskId === task.id
  const needsInstructions = (task.status === 'waiting' && task.waitingReason === 'input')
    || ((task.status === 'proposed' || task.status === 'failed') && task.prompt === undefined)
  const hasActions = task.status === 'proposed'
    || task.status === 'waiting'
    || task.status === 'failed'
    || task.status === 'queued'
    || task.status === 'running'
  const detail = task.detail ?? t(`tasks.statusDetail.${task.status}`)

  return (
    <article className={`task-row task-card-card task-card-${task.status}`} aria-busy={busy} data-task-id={task.id}>
      <button
        aria-label={`${t('tasks.openDetails')}: ${task.title}`}
        className="task-card-main"
        onClick={() => onOpenTask(task)}
        type="button"
      >
        <span className="task-card-title-line">
          <TaskStatusGlyph status={task.status} />
          <span className="task-card-title">{task.title}</span>
        </span>
        <span className={`task-status task-status-${task.status}`}>{t(`tasks.status.${task.status}`)}</span>
        {(NEEDS_YOU.has(task.status) || task.status === 'cancelled') && (
          <span className="task-card-detail">{detail}</span>
        )}
        <span className="task-card-agent">
          <span className="task-card-agent-avatar" aria-hidden="true"><Bot size={11} /></span>
          <span>{t('tasks.agentName')}</span>
        </span>
        <time className="task-card-updated" dateTime={task.updatedAt}>
          {updatedLabel(task.updatedAt, dateLocale, t)}
        </time>
      </button>

      {!editing && hasActions && (
        <div className="task-card-actions">
          {task.status === 'proposed' && task.prompt !== undefined && (
            <button className="task-action primary" type="button" disabled={busy} onClick={() => void onStatus(task, 'queued')}>
              {t('tasks.run')}
            </button>
          )}
          {task.status === 'waiting' && task.waitingReason === 'approval' && (
            <button className="task-action primary" type="button" disabled={busy} onClick={() => void onResolveApproval(task, 'approved')}>
              {t('tasks.approve')}
            </button>
          )}
          {task.status === 'waiting' && task.waitingReason === 'review' && (
            <button className="task-action primary" type="button" disabled={busy} onClick={() => void onStatus(task, 'completed')}>
              {t('tasks.markComplete')}
            </button>
          )}
          {task.status === 'failed' && task.prompt !== undefined && (
            <button className="task-action primary" type="button" disabled={busy} onClick={() => void onStatus(task, 'queued')}>
              {t('tasks.retry')}
            </button>
          )}
          {needsInstructions && (
            <button className="task-action primary" type="button" disabled={busy} onClick={() => onEdit(task)}>
              {t('tasks.addInstructions')}
            </button>
          )}
          {(task.status === 'proposed' || task.status === 'waiting' || task.status === 'failed') && (
            <button className="task-action quiet" type="button" disabled={busy} onClick={() => void (task.approvalId === undefined ? onStatus(task, 'cancelled') : onResolveApproval(task, 'denied'))}>
              {t('tasks.dismiss')}
            </button>
          )}
          {(task.status === 'queued' || task.status === 'running') && (
            <button className="task-action quiet" type="button" disabled={busy} onClick={() => void onStatus(task, 'cancelled')}>
              {t('tasks.cancel')}
            </button>
          )}
        </div>
      )}

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

function TaskStatusGlyph({ status }: { status: TaskStatus }) {
  if (status === 'running' || status === 'queued') {
    return <LoaderCircle className="task-card-status-icon task-card-status-spin" size={16} aria-hidden="true" />
  }
  if (status === 'completed') return <CircleCheck className="task-card-status-icon task-card-status-completed" size={16} aria-hidden="true" />
  if (status === 'cancelled') return <CircleX className="task-card-status-icon task-card-status-cancelled" size={16} aria-hidden="true" />
  if (status === 'failed') return <CircleX className="task-card-status-icon task-card-status-failed" size={16} aria-hidden="true" />
  return <CircleAlert className="task-card-status-icon task-card-status-waiting" size={16} aria-hidden="true" />
}

function updatedLabel(value: string, locale: string, t: ReturnType<typeof useTranslation>['t']): string {
  const translate = t as (key: string, options?: Record<string, unknown>) => string
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const formatted = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
  return translate('tasks.updatedOn', { date: formatted })
}

function taskTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? prompt.trim()
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
