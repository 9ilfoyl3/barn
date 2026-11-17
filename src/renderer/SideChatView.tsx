import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip } from 'lucide-react'
import type { SessionLiveEvent, ModelConfigSnapshot, AttachmentDescriptor } from '../shared/models'
import { AttachmentStrip } from './AttachmentStrip'
import { ModelPicker } from './ModelPicker'
import { ConversationParts, PendingThinking } from './ConversationParts'
import { MessageBubble, MessageBubbleGroup } from '@/components/beui/components/agents/message-bubble'
import { PromptInput } from '@/components/beui/components/agents/prompt-input'
import {
  applyLiveEvent,
  messagesFromEvents,
  type ChatMessage,
  type ConversationPart,
} from './conversation'

export interface SideChatViewProps {
  sessionId: string
  parentSessionId?: string | undefined
  workingDirectory?: string | undefined
  onConfigureModel: () => void
  onError: (message: string) => void
}

export function SideChatView({
  sessionId,
  parentSessionId,
  workingDirectory,
  onConfigureModel,
  onError,
}: SideChatViewProps) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const listRef = useRef<HTMLElement>(null)

  useEffect(() => {
    void window.barn.models.getSnapshot().then(setSnapshot).catch((reason: unknown) => onError(errorMessage(reason)))
    void window.barn.sessions.create(sessionId, parentSessionId)
      .then(async () => {
        setReady(true)
        await load()
      })
      .catch((reason: unknown) => onError(errorMessage(reason)))
  }, [parentSessionId, sessionId])

  useEffect(() => window.barn.sessions.onEvent((event) => handleEvent(event)), [sessionId])

  useEffect(() => {
    const element = listRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
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
      if (event.session.status !== 'running') {
        setStopping(false)
        void load()
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
        void load()
        if (event.status === 'failed') onError(event.error ?? t('conversation.runFailed'))
      }
    }
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (text.length === 0 || pending || modelSelectionBusy || !ready) return
    const filesToSend = attachments
    setInput('')
    setAttachments([])
    setPending(true)
    setLiveParts([])
    try {
      await window.barn.sessions.prompt({
        sessionId,
        text,
        attachments: filesToSend,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      })
    } catch (reason) {
      setPending(false)
      onError(errorMessage(reason))
    }
  }

  async function attachFiles(): Promise<void> {
    try {
      const selected = await window.barn.sessions.attach(sessionId)
      setAttachments((current) => [...current, ...selected])
    } catch (reason) {
      onError(errorMessage(reason))
    }
  }

  async function cancel(): Promise<void> {
    if (!pending || stopping) return
    setStopping(true)
    try {
      await window.barn.sessions.cancel(sessionId)
    } catch (reason) {
      setStopping(false)
      onError(errorMessage(reason))
    }
  }

  return (
    <div className="conversation-view side-chat-conversation">
      <section
        ref={listRef}
        className={messages.length === 0 && liveParts.length === 0 && !pending ? 'conversation-surface empty-conversation' : 'conversation-surface chat-surface'}
      >
        {messages.length === 0 && liveParts.length === 0 && !pending ? (
          <div className="side-chat-empty">{t('sideChat.empty')}</div>
        ) : (
          <MessageBubbleGroup className="message-list" spacing="default">
            {messages.map((message) => (
              <MessageBubble
                aria-label={message.role === 'user' ? t('conversation.userMessage') : t('conversation.barnMessage')}
                align={message.role === 'user' ? 'end' : 'start'}
                className={`chat-message ${message.role}${message.isError ? ' error' : ''}`}
                key={message.key}
                role="article"
                variant="ghost"
              >
                <ConversationParts parts={message.parts} role={message.role} keyPrefix={message.key} />
              </MessageBubble>
            ))}
            {liveParts.length > 0 && (
              <MessageBubble
                aria-label={t('conversation.barnMessage')}
                align="start"
                className="chat-message assistant"
                role="article"
                variant="ghost"
              >
                {liveParts.some((part) => part.type === 'tool' || part.type === 'thinking') && <PendingThinking />}
                <ConversationParts parts={liveParts} role="assistant" keyPrefix="live" />
              </MessageBubble>
            )}
          </MessageBubbleGroup>
        )}
      </section>

      <div className="composer-dock side-chat-composer-dock">
        <div className="composer composer-agents">
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
            aria-label={t('sideChat.input')}
            className="barn-prompt-input"
            disabled={modelSelectionBusy || !ready}
            leadingAction={(
              <ModelPicker
                snapshot={snapshot}
                onSnapshot={setSnapshot}
                onConfigure={onConfigureModel}
                onBusyChange={setModelSelectionBusy}
              />
            )}
            loading={pending}
            maxRows={8}
            minRows={2}
            onAction={(action) => {
              if (action === 'attach') void attachFiles()
            }}
            onStop={() => void cancel()}
            onSubmit={() => void send()}
            onValueChange={setInput}
            placeholder={t('sideChat.placeholder')}
            sendLabel={t('conversation.sendMessage')}
            stopLabel={t('conversation.stopResponse')}
            stopping={stopping}
            stoppingLabel={t('conversation.stoppingResponse')}
            value={input}
          />
        </div>
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
