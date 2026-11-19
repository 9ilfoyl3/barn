import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock3,
  Folder,
  Link2,
  LoaderCircle,
  Monitor,
  Paperclip,
  Plus,
  Repeat2,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AttachmentDescriptor, SessionLiveEvent, Task } from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'
import { AttachmentStrip } from './AttachmentStrip'
import { ConversationParts, PendingThinking } from './ConversationParts'
import { MessageBubble } from '@/components/beui/components/agents/message-bubble'
import { PromptInput } from '@/components/beui/components/agents/prompt-input'
import {
  applyLiveEvent,
  messagesFromEvents,
  type ChatMessage,
  type ConversationPart,
} from './conversation'
import './task-detail.css'

const TASK_TAG_VALUES = ['work', 'reminder', 'important', 'followUp'] as const
type TaskTagValue = typeof TASK_TAG_VALUES[number]
const TASK_TAG_STORAGE_PREFIX = 'barn.task-detail.tags.'

export function TaskDetailPage({ task, onBack }: { task: Task; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en'
  const [activeSessionId, setActiveSessionId] = useState(task.sessionId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [loading, setLoading] = useState(task.sessionId !== undefined)
  const [error, setError] = useState<string>()
  const [statusBusy, setStatusBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [tags, setTags] = useState<TaskTagValue[]>(() => readTaskTags(task.id))
  const threadRef = useRef<HTMLDivElement>(null)
  const sessionTaskRef = useRef(task.id)
  const sessionPromiseRef = useRef<Promise<string> | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tagMenuRef = useRef<HTMLDivElement>(null)

  sessionTaskRef.current = task.id

  useEffect(() => {
    setActiveSessionId(task.sessionId)
    setMessages([])
    setLiveParts([])
    setInput('')
    setAttachments([])
    setPending(false)
    setStopping(false)
    setLoading(task.sessionId !== undefined)
    setError(undefined)
    setStatusBusy(false)
    setTagMenuOpen(false)
    setTags(readTaskTags(task.id))
    sessionPromiseRef.current = null
  }, [task.id, task.sessionId])

  useEffect(() => {
    const sessionId = activeSessionId
    if (sessionId === undefined) return
    let cancelled = false
    setLoading(true)
    void loadMessages(sessionId, cancelled)
    const unsubscribe = window.barn.sessions.onEvent((event) => handleSessionEvent(event))
    return () => {
      cancelled = true
      unsubscribe()
    }

    async function loadMessages(sessionId: string, isCancelled: boolean): Promise<void> {
      try {
        const events = await window.barn.sessions.getEvents(sessionId)
        if (isCancelled) return
        const projected = messagesFromEvents(events).map((message, index) => (
          message.role === 'user' && index === 0 && task.visiblePrompt !== undefined
            ? { ...message, parts: [{ type: 'text' as const, text: task.visiblePrompt }] }
            : message
        ))
        setMessages(projected)
        setError(undefined)
      } catch (reason) {
        if (!isCancelled) setError(errorMessage(reason))
      } finally {
        if (!isCancelled) setLoading(false)
      }
    }

    function handleSessionEvent(event: SessionLiveEvent): void {
      if (event.type === 'session.updated') {
        if (event.session.id !== sessionId) return
        setPending(event.session.status === 'running')
        if (event.session.status !== 'running') {
          setStopping(false)
          void loadMessages(sessionId, false)
        }
        return
      }
      if (event.sessionId !== sessionId) return
      if (event.type === 'assistant.delta' || event.type === 'assistant.thinking' || event.type === 'tool.started' || event.type === 'tool.finished') {
        setLiveParts((current) => applyLiveEvent(current, event))
        return
      }
      if (event.type === 'run.status') {
        setPending(event.status === 'running')
        if (event.status !== 'running') {
          setStopping(false)
          setLiveParts([])
          void loadMessages(sessionId, false)
          if (event.status === 'failed') setError(event.error ?? t('conversation.runFailed'))
        }
      }
    }
  }, [activeSessionId, task.id, task.visiblePrompt, t])

  useLayoutEffect(() => {
    const thread = threadRef.current
    if (thread === null) return
    thread.scrollTop = thread.scrollHeight
  }, [messages, liveParts, pending, error])

  useEffect(() => {
    if (!tagMenuOpen) return
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && tagMenuRef.current?.contains(event.target) === true) return
      setTagMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [tagMenuOpen])

  useEffect(() => () => {
    if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current)
  }, [])

  const initialMessages = messages.length > 0 ? messages : messagesFromTask(task)
  const timestampValue = task.startedAt ?? task.createdAt
  const timestamp = new Date(timestampValue)
  const validTimestamp = !Number.isNaN(timestamp.getTime())
  const timeText = validTimestamp
    ? new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
    : ''
  const dateText = validTimestamp
    ? isSameLocalDay(timestamp, new Date())
      ? t('tasks.todayAt', { time: timeText })
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp)
    : ''
  const platform = taskPlatformLabel()
  const statusLabel = t(`tasks.status.${task.status}`)
  const workingDirectory = task.workingDirectory

  async function ensureTaskSession(): Promise<string> {
    const known = activeSessionId ?? task.sessionId
    if (known !== undefined) return known
    if (sessionPromiseRef.current !== null) return sessionPromiseRef.current
    const taskId = task.id
    const promise = (async () => {
      const created = await window.barn.sessions.create()
      await window.barn.tasks.assignSession(taskId, created.id)
      if (sessionTaskRef.current === taskId) setActiveSessionId(created.id)
      return created.id
    })()
    sessionPromiseRef.current = promise
    try {
      return await promise
    } finally {
      if (sessionPromiseRef.current === promise) sessionPromiseRef.current = null
    }
  }

  async function sendPrompt(value: string): Promise<void> {
    const text = value.trim()
    if (text.length === 0 || pending) return
    const filesToSend = attachments
    setInput('')
    setAttachments([])
    setPending(true)
    setError(undefined)
    try {
      const sessionId = await ensureTaskSession()
      await window.barn.sessions.prompt({
        sessionId,
        text,
        attachments: filesToSend,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      })
    } catch (reason) {
      setPending(false)
      setInput(text)
      setAttachments(filesToSend)
      setError(errorMessage(reason))
    }
  }

  async function attachFiles(): Promise<void> {
    try {
      const sessionId = await ensureTaskSession()
      const selected = await window.barn.sessions.attach(sessionId)
      setAttachments((current) => [...current, ...selected])
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function cancelRun(): Promise<void> {
    if (!pending || stopping || activeSessionId === undefined) return
    setStopping(true)
    try {
      await window.barn.sessions.cancel(activeSessionId)
    } catch (reason) {
      setStopping(false)
      setError(errorMessage(reason))
    }
  }

  async function updateStatus(status: 'completed' | 'waiting'): Promise<void> {
    if (statusBusy) return
    setStatusBusy(true)
    setError(undefined)
    try {
      await window.barn.tasks.updateStatus(task.id, status === 'completed'
        ? { status }
        : { status, waitingReason: 'input', detail: t('tasks.awaitingReview') })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setStatusBusy(false)
    }
  }

  async function copyTaskLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(task.id)
      setCopied(true)
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1_600)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  function toggleTag(tag: TaskTagValue): void {
    setTags((current) => {
      const next = current.includes(tag)
        ? current.filter((candidate) => candidate !== tag)
        : [...current, tag]
      persistTaskTags(task.id, next)
      return next
    })
  }

  function renderMessage(message: ChatMessage) {
    const user = message.role === 'user'
    return (
      <article
        className={`task-detail-message task-detail-message-${message.role}`}
        data-message-key={message.key}
        key={message.key}
      >
        <span className="task-detail-message-avatar" aria-hidden="true">
          {user ? <UserRound size={12} /> : <Sparkles size={12} />}
        </span>
        <div className="task-detail-message-stack">
          <span className="task-detail-message-author">
            {user ? t('tasks.senderYou') : t('tasks.taskAgent')}
          </span>
          <MessageBubble
            align="start"
            className="task-detail-message-bubble"
            role="article"
            variant="ghost"
          >
            <ConversationParts
              parts={message.parts}
              role={message.role}
              keyPrefix={message.key}
            />
            {message.attachments.length > 0 && (
              <div className="task-detail-message-attachments">
                {message.attachments.map((file) => (
                  <span
                    className="task-detail-message-attachment"
                    key={`${message.key}:${file.path}`}
                    title={attachmentDisplayName(file)}
                  >
                    {file.kind === 'directory' ? <Folder size={11} /> : <Paperclip size={11} />}
                    <span>{attachmentDisplayName(file)}</span>
                    {file.size > 0 && <small>{formatFileSize(file.size)}</small>}
                  </span>
                ))}
              </div>
            )}
          </MessageBubble>
        </div>
      </article>
    )
  }

  return (
    <section className="task-detail-page" aria-label={task.title}>
      <header className="task-detail-header">
        <button
          className="task-detail-back"
          type="button"
          aria-label={t('tasks.back')}
          title={t('tasks.back')}
          onClick={onBack}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="task-detail-title-row">
          <h1>{task.title}</h1>
          <button
            className="task-detail-link"
            type="button"
            aria-label={copied ? t('tasks.linkCopied') : t('tasks.copyTaskLink')}
            title={copied ? t('tasks.linkCopied') : t('tasks.copyTaskLink')}
            onClick={() => void copyTaskLink()}
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <div className="task-detail-body">
        <section className="task-detail-conversation" aria-label={t('tasks.taskChat')}>
          <div ref={threadRef} className="task-detail-thread" role="log" aria-label={t('tasks.taskConversation')}>
            {dateText.length > 0 && <div className="task-detail-date">{dateText}</div>}
            {loading && (
              <div className="task-detail-loading" role="status">
                <LoaderCircle size={15} aria-hidden="true" />
                <span>{t('tasks.loadingDetails')}</span>
              </div>
            )}
            {initialMessages.map(renderMessage)}
            {(pending || liveParts.length > 0) && (
              <article className="task-detail-message task-detail-message-assistant task-detail-live-message">
                <span className="task-detail-message-avatar" aria-hidden="true">
                  <Sparkles size={12} />
                </span>
                <div className="task-detail-message-stack">
                  <span className="task-detail-message-author">{t('tasks.taskAgent')}</span>
                  {liveParts.length === 0 ? (
                    <PendingThinking label={t('conversation.thinkingNow')} />
                  ) : (
                    <MessageBubble align="start" className="task-detail-message-bubble" role="article" variant="ghost">
                      <ConversationParts parts={liveParts} role="assistant" keyPrefix="task-live" />
                    </MessageBubble>
                  )}
                </div>
              </article>
            )}
            {!loading && initialMessages.length === 0 && liveParts.length === 0 && !pending && (
              <div className="task-detail-thread-empty">
                <Sparkles size={18} aria-hidden="true" />
                <p>{t('tasks.chatEmpty')}</p>
              </div>
            )}
            {error !== undefined && <div className="error-banner task-detail-error" role="alert">{error}</div>}
            <div className="task-detail-quick-actions" aria-label={t('tasks.taskActions')}>
              <button
                className="task-detail-quick-action"
                type="button"
                disabled={statusBusy}
                onClick={() => void updateStatus('completed')}
              >
                <CircleCheck size={14} aria-hidden="true" />
                <span>{t('tasks.markComplete')}</span>
              </button>
              <button
                className="task-detail-quick-action"
                type="button"
                disabled={statusBusy}
                onClick={() => void updateStatus('waiting')}
              >
                <Clock3 size={14} aria-hidden="true" />
                <span>{t('tasks.markWaiting')}</span>
              </button>
            </div>
          </div>

          <div className="task-detail-composer-dock">
            {attachments.length > 0 && (
              <AttachmentStrip
                files={attachments}
                onRemove={(path) => setAttachments((current) => current.filter((item) => item.path !== path))}
              />
            )}
            <PromptInput
              addActionLabel={t('conversation.attach')}
              actions={[{
                value: 'attach',
                label: t('conversation.filesAndFolders'),
                description: t('conversation.addMenuTitle'),
                icon: <Paperclip size={15} />,
              }]}
              aria-label={t('tasks.messageTaskAgent')}
              className="barn-prompt-input task-detail-prompt-input"
              loading={pending}
              maxRows={4}
              minRows={1}
              onAction={(action) => {
                if (action === 'attach') void attachFiles()
              }}
              onSubmit={(value) => void sendPrompt(value)}
              onStop={() => void cancelRun()}
              onValueChange={setInput}
              placeholder={t('tasks.chatPlaceholder')}
              sendLabel={t('conversation.sendMessage')}
              stopping={stopping}
              stoppingLabel={t('conversation.stoppingResponse')}
              stopLabel={t('conversation.stopResponse')}
              value={input}
            />
          </div>
        </section>

        <aside className="task-detail-properties" aria-label={t('tasks.properties')}>
          <div className="task-detail-properties-scroll">
            <section className="task-detail-property-section">
              <h2>{t('tasks.properties')}</h2>
              <div className={`task-detail-property-row task-detail-property-status task-detail-property-status-${task.status}`}>
                <TaskStatusGlyph status={task.status} />
                <span>{statusLabel}</span>
              </div>
              <div className="task-detail-property-row">
                <span className={`task-detail-origin-avatar task-detail-origin-avatar-${task.origin}`} aria-hidden="true">
                  {task.origin === 'automation' ? 'B' : 'Y'}
                </span>
                <span>{task.origin === 'automation' ? t('secretary.automation') : t('secretary.you')}</span>
              </div>
              <div className="task-detail-property-row">
                <Monitor size={15} aria-hidden="true" />
                <span>{t('tasks.createdFrom', { platform })}</span>
              </div>
              {task.scheduledFor !== undefined && (
                <div className="task-detail-property-row">
                  <CalendarClock size={15} aria-hidden="true" />
                  <span>{t('tasks.scheduledFor', { date: formatScheduledDate(task.scheduledFor, locale) })}</span>
                </div>
              )}
              {task.recurrence !== undefined && task.recurrence !== 'none' && (
                <div className="task-detail-property-row">
                  <Repeat2 size={15} aria-hidden="true" />
                  <span>{t(`tasks.recurrence.${task.recurrence}`)}</span>
                </div>
              )}
              {workingDirectory !== undefined && (
                <div className="task-detail-property-row task-detail-property-path" title={workingDirectory}>
                  <Folder size={15} aria-hidden="true" />
                  <span>{workingDirectory}</span>
                </div>
              )}
            </section>

            <section className="task-detail-property-section">
              <h2>{t('tasks.tags')}</h2>
              <div className="task-detail-tags" ref={tagMenuRef}>
                {tags.map((tag) => (
                  <span className="task-detail-tag" key={tag}>
                    <span className={`task-detail-tag-dot task-detail-tag-dot-${tag}`} aria-hidden="true" />
                    {t(`tasks.tagPreset.${tag}`)}
                  </span>
                ))}
                <div className="task-detail-tag-control">
                  <button
                    className={`task-detail-add-tag${tags.length === 0 ? ' is-labeled' : ''}`}
                    type="button"
                    aria-label={t('tasks.addTag')}
                    aria-expanded={tagMenuOpen}
                    onClick={() => setTagMenuOpen((open) => !open)}
                  >
                    <Plus size={13} aria-hidden="true" />
                    {tags.length === 0 && <span>{t('tasks.addTag')}</span>}
                  </button>
                  {tagMenuOpen && (
                    <div className="task-detail-tag-menu" role="menu" aria-label={t('tasks.tags')}>
                      {TASK_TAG_VALUES.map((tag) => {
                        const checked = tags.includes(tag)
                        return (
                          <button
                            className="task-detail-tag-option"
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={checked}
                            key={tag}
                            onClick={() => toggleTag(tag)}
                          >
                            <span className={`task-detail-tag-dot task-detail-tag-dot-${tag}`} aria-hidden="true" />
                            <span>{t(`tasks.tagPreset.${tag}`)}</span>
                            {checked && <Check size={13} aria-hidden="true" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </section>
  )
}

function TaskStatusGlyph({ status }: { status: Task['status'] }) {
  if (status === 'running' || status === 'queued') {
    return <LoaderCircle className="task-detail-status-spinner" size={15} aria-hidden="true" />
  }
  if (status === 'completed') return <CircleCheck size={15} aria-hidden="true" />
  if (status === 'failed') return <CircleX size={15} aria-hidden="true" />
  if (status === 'cancelled') return <CircleX size={15} aria-hidden="true" />
  if (status === 'waiting') return <CircleAlert size={15} aria-hidden="true" />
  return <Circle size={15} aria-hidden="true" />
}

function messagesFromTask(task: Task): ChatMessage[] {
  const prompt = task.visiblePrompt ?? task.prompt
  if (prompt === undefined || prompt.trim().length === 0) return []
  return [{
    key: `task-prompt:${task.id}`,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
    attachments: task.attachments ?? [],
    isError: false,
    createdAt: task.createdAt,
  }]
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function formatScheduledDate(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function taskPlatformLabel(): string {
  if (window.barn.platform === 'darwin') return 'macOS'
  if (window.barn.platform === 'win32') return 'Windows'
  if (window.barn.platform === 'linux') return 'Linux'
  return window.barn.platform
}

function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_048_576) return `${Math.round(size / 1_024)} KB`
  return `${(size / 1_048_576).toFixed(1)} MB`
}

function readTaskTags(taskId: string): TaskTagValue[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${TASK_TAG_STORAGE_PREFIX}${taskId}`) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is TaskTagValue => (
      typeof value === 'string' && TASK_TAG_VALUES.includes(value as TaskTagValue)
    ))
  } catch {
    return []
  }
}

function persistTaskTags(taskId: string, tags: TaskTagValue[]): void {
  try {
    window.localStorage.setItem(`${TASK_TAG_STORAGE_PREFIX}${taskId}`, JSON.stringify(tags))
  } catch {
    // Tags remain available for the current render if local persistence is unavailable.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
