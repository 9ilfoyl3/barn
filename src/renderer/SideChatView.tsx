import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { useTranslation } from 'react-i18next'
import type { SessionLiveEvent } from '../shared/models'
import {
  applyLiveEvent,
  messagesFromEvents,
  type ChatMessage,
  type ConversationPart,
} from './conversation'

export interface SideChatViewProps {
  sessionId: string
  workingDirectory?: string | undefined
  onError: (message: string) => void
}

export function SideChatView({ sessionId, workingDirectory, onError }: SideChatViewProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [ready, setReady] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.barn.sessions.create(sessionId)
      .then(async () => {
        setReady(true)
        await load()
      })
      .catch((reason: unknown) => onError(errorMessage(reason)))
  }, [sessionId])

  useEffect(() => window.barn.sessions.onEvent((event) => handleEvent(event)), [sessionId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, liveParts])

  async function load(): Promise<void> {
    try {
      setMessages(messagesFromEvents(await window.barn.sessions.getEvents(sessionId)))
    } catch (reason) {
      onError(errorMessage(reason))
    }
  }

  function handleEvent(event: SessionLiveEvent): void {
    if (event.type === 'session.updated') {
      if (event.session.id !== sessionId) return
      setPending(event.session.status === 'running')
      if (event.session.status !== 'running') void load()
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
        setLiveParts([])
        void load()
      }
    }
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (text.length === 0 || pending || !ready) return
    setInput('')
    setPending(true)
    setLiveParts([])
    try {
      await window.barn.sessions.prompt({
        sessionId,
        text,
        attachments: [],
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      })
    } catch (reason) {
      setPending(false)
      onError(errorMessage(reason))
    }
  }

  return (
    <div className="side-chat-view">
      <div className="side-chat-messages" ref={listRef}>
        {messages.length === 0 && liveParts.length === 0 && (
          <div className="side-chat-empty">{t('sideChat.empty')}</div>
        )}
        {messages.map((message) => (
          <div className={`side-chat-message is-${message.role}`} key={message.key}>
            {message.parts.map((part, index) => part.type === 'text'
              ? <Streamdown key={index}>{part.text}</Streamdown>
              : null)}
          </div>
        ))}
        {liveParts.length > 0 && (
          <div className="side-chat-message is-assistant">
            {liveParts.map((part, index) => part.type === 'text'
              ? <Streamdown key={index}>{part.text}</Streamdown>
              : part.type === 'thinking'
                ? <p className="side-chat-thinking" key={index}>{part.text}</p>
                : null)}
          </div>
        )}
      </div>
      <form className="side-chat-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <textarea
          aria-label={t('sideChat.input')}
          disabled={!ready}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={t('sideChat.placeholder')}
          rows={2}
        />
        <button type="submit" disabled={!ready || pending || input.trim().length === 0}>
          {pending ? t('sideChat.working') : t('sideChat.send')}
        </button>
      </form>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
