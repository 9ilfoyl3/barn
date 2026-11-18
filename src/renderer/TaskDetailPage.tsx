import { useEffect, useState } from 'react'
import { ArrowLeft, CalendarClock, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task } from '../shared/models'
import { ConversationParts } from './ConversationParts'
import { messagesFromEvents, type ChatMessage } from './conversation'
import './task-detail.css'

export function TaskDetailPage({ task, onBack }: { task: Task; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(task.sessionId !== undefined)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (task.sessionId === undefined) {
      setMessages([])
      setLoading(false)
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const events = await window.barn.sessions.getEvents(task.sessionId!)
        if (cancelled) return
        const projected = messagesFromEvents(events).map((message, index) => (
          message.role === 'user' && index === 0 && task.visiblePrompt !== undefined
            ? { ...message, parts: [{ type: 'text' as const, text: task.visiblePrompt }] }
            : message
        ))
        setMessages(projected)
        setError(undefined)
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const unsubscribe = window.barn.sessions.onEvent((event) => {
      if (event.type === 'session.updated' && event.session.id !== task.sessionId) return
      if ('sessionId' in event && event.sessionId !== task.sessionId) return
      void load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [task.id, task.sessionId, task.visiblePrompt])

  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en'
  return (
    <section className="task-detail-page" aria-label={task.title}>
      <header className="task-detail-header">
        <button type="button" className="task-detail-back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
          <span>{t('tasks.back')}</span>
        </button>
        <div className="task-detail-heading">
          <div>
            <h1>{task.title}</h1>
            <p>{task.detail ?? t(`tasks.statusDetail.${task.status}`)}</p>
          </div>
          <span className={`task-status task-status-${task.status}`}>{t(`tasks.status.${task.status}`)}</span>
        </div>
        {task.scheduledFor !== undefined && (
          <div className="task-detail-schedule">
            <CalendarClock size={14} aria-hidden="true" />
            <span>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(task.scheduledFor))}</span>
          </div>
        )}
      </header>

      <div className="task-detail-transcript">
        {loading && (
          <div className="task-detail-loading" role="status">
            <LoaderCircle size={16} aria-hidden="true" />
            <span>{t('tasks.loadingDetails')}</span>
          </div>
        )}
        {!loading && task.sessionId === undefined && (
          <div className="task-detail-empty">
            <strong>{t('tasks.notStarted')}</strong>
            <p>{t('tasks.notStartedDescription')}</p>
          </div>
        )}
        {messages.map((message) => (
          <article
            className={`task-detail-message task-detail-message-${message.role}`}
            key={message.key}
          >
            <span className="task-detail-role">
              {message.role === 'user' ? t('conversation.userMessage') : t('conversation.barnMessage')}
            </span>
            <ConversationParts parts={message.parts} role={message.role} keyPrefix={message.key} />
          </article>
        ))}
        {error !== undefined && <div className="error-banner" role="alert">{error}</div>}
      </div>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
