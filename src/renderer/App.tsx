import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Streamdown, type Components } from 'streamdown'
import 'streamdown/styles.css'
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleX,
  ArrowUp,
  ChevronDown,
  FilePlus,
  FileSearch,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Inbox,
  Search,
  Wrench,
  LoaderCircle,
  PanelLeft,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Stethoscope,
  Terminal,
  UserRound,
  X,
} from 'lucide-react'
import type {
  AttachmentDescriptor,
  ModelConfigSnapshot,
  RuntimeCapabilities,
  SessionLiveEvent,
  SessionSummary,
  Task,
  TaskLiveEvent,
} from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'
import { ModelSettings } from './ModelSettings'
import { ModelPicker } from './ModelPicker'
import { LanguagePicker } from './LanguagePicker'
import { SourceSettings } from './SourceSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import './composer-workspace.css'
import { TaskCenter } from './TaskCenter'
import { initializeAppLanguage } from './i18n'
import { TooltipButton } from './components/TooltipButton'
import {
  applyLiveEvent,
  groupConversationParts,
  messagesFromEvents,
  type ChatMessage,
  type ConversationPart,
  type ToolCallView,
} from './conversation'

const STREAMDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <pre>{children}</pre>,
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
}

export function App() {
  const { t, i18n } = useTranslation()
  const dateLocale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [workingDirectory, setWorkingDirectory] = useState<string>()
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [contextStatus, setContextStatus] = useState<{ tokens: number; budget: number; compacted: boolean }>()
  const [accountOpen, setAccountOpen] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [view, setView] = useState<'conversation' | 'tasks'>('conversation')
  const [tasks, setTasks] = useState<Task[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [taskError, setTaskError] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const sessionSearchInputRef = useRef<HTMLInputElement>(null)
  const accountAreaRef = useRef<HTMLDivElement>(null)
  const attachAreaRef = useRef<HTMLDivElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!sessionSearchOpen) {
      sessionSearchInputRef.current?.blur()
      return
    }
    const frame = requestAnimationFrame(() => sessionSearchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [sessionSearchOpen])

  useEffect(() => {
    void initializeAppLanguage()
    const applyTheme = (state: { shouldUseDarkColors: boolean }): void => {
      document.documentElement.dataset.theme = state.shouldUseDarkColors ? 'dark' : 'light'
    }
    void window.barn.theme.getState().then(applyTheme).catch(() => undefined)
    const unsubscribeTheme = window.barn.theme.onChange(applyTheme)
    void window.barn.models.getSnapshot()
      .then(setSnapshot)
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    void window.barn.sessions.list()
      .then((value) => {
        setSessions(value)
        const initialSessionId = value[0]?.id
        activeSessionIdRef.current = initialSessionId
        setActiveSessionId(initialSessionId)
      })
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    void window.barn.tasks.list()
      .then((value) => {
        setTasks(value)
        setTaskError(undefined)
      })
      .catch((reason: unknown) => setTaskError(errorMessage(reason, t)))
      .finally(() => setTasksLoading(false))
    const unsubscribeTasks = window.barn.tasks.onEvent(handleTaskEvent)
    void window.barn.getCapabilities()
      .then(setCapabilities)
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    return () => {
      unsubscribeTheme()
      unsubscribeTasks()
    }
  }, [])

  useEffect(() => {
    if (!accountOpen) return

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      const targetElement = target instanceof Element ? target : target.parentElement
      const insideAccount = accountAreaRef.current?.contains(target) ?? false
      const insideLanguageMenu = targetElement?.closest('.language-submenu') !== null
      if (accountOpen && !insideAccount && !insideLanguageMenu) setAccountOpen(false)
    }

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.language-submenu') !== null) return
      event.preventDefault()
      if (accountOpen) {
        setAccountOpen(false)
        accountTriggerRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountOpen])

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
    setMessages([])
    setLiveParts([])
    setAttachments([])
    setContextStatus(undefined)
    if (activeSessionId === undefined) return
    void loadSession(activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    if (activeSessionId === undefined) return
    const session = sessions.find((item) => item.id === activeSessionId)
    if (session?.workingDirectory !== undefined) setWorkingDirectory(session.workingDirectory)
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (!attachMenuOpen) return
    const close = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!(attachAreaRef.current?.contains(target) ?? false)) setAttachMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAttachMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [attachMenuOpen])

  useEffect(() => {
    return window.barn.sessions.onEvent(handleLiveEvent)
  }, [])

  useEffect(() => window.barn.lifecycle.onShowTasks(() => setView('tasks')), [])

  useEffect(() => {
    const element = listRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [messages, liveParts])

  async function loadSession(sessionId: string): Promise<void> {
    try {
      const events = await window.barn.sessions.getEvents(sessionId)
      setMessages(messagesFromEvents(events))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  function handleTaskEvent(event: TaskLiveEvent): void {
    setTasks((current) => upsertTask(current, event.task))
  }

  function handleLiveEvent(event: SessionLiveEvent): void {
    const sessionId = activeSessionIdRef.current
    if (event.type === 'session.updated') {
      setSessions((current) => upsertSession(current, event.session))
      if (event.session.id === sessionId) void loadSession(sessionId)
      return
    }
    if (event.sessionId !== sessionId) return

    if (event.type === 'context.updated') {
      setContextStatus({ tokens: event.tokens, budget: event.budget, compacted: event.compacted })
      return
    }
    if (event.type === 'assistant.delta') {
      setLiveParts((current) => applyLiveEvent(current, event))
      return
    }
    if (event.type === 'assistant.thinking') {
      setLiveParts((current) => applyLiveEvent(current, event))
      return
    }
    if (event.type === 'tool.started') {
      setLiveParts((current) => applyLiveEvent(current, event))
      return
    }
    if (event.type === 'tool.finished') {
      setLiveParts((current) => applyLiveEvent(current, event))
      return
    }
    if (event.type === 'run.status') {
      setPending(event.status === 'running')
      if (event.status !== 'running') {
        setLiveParts([])
        void loadSession(sessionId)
        if (event.status === 'failed') setError(event.error ?? t('conversation.runFailed'))
      }
    }
  }

  function startNewSession(): void {
    setView('conversation')
    draftSessionIdRef.current = crypto.randomUUID()
    activeSessionIdRef.current = undefined
    setActiveSessionId(undefined)
    setMessages([])
    setLiveParts([])
    setInput('')
    setAttachments([])
    setWorkingDirectory(undefined)
    setContextStatus(undefined)
    setPending(false)
    setError(undefined)
  }

  async function sendPrompt(): Promise<void> {
    const text = input.trim()
    if (text.length === 0 || pending || modelSelectionBusy) return
    const isNewSession = activeSessionId === undefined
    const sessionId = activeSessionId ?? draftSessionId()

    const filesToSend = attachments
    try {
      if (isNewSession) await window.barn.sessions.create(sessionId)
      activeSessionIdRef.current = sessionId
      setActiveSessionId(sessionId)
      setPending(true)
      setError(undefined)
      setLiveParts([])
      setInput('')
      setAttachments([])
      const session = await window.barn.sessions.prompt({
        sessionId,
        text,
        attachments: filesToSend,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      })
      draftSessionIdRef.current = undefined
      setSessions((current) => upsertSession(current, session))
    } catch (reason) {
      if (isNewSession) activeSessionIdRef.current = undefined
      setPending(false)
      setError(errorMessage(reason, t))
    }
  }

  async function cancelRun(): Promise<void> {
    const sessionId = activeSessionId ?? activeSessionIdRef.current
    if (sessionId === undefined) return
    try {
      await window.barn.sessions.cancel(sessionId)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function attachFiles(kind: 'files' | 'folder'): Promise<void> {
    const sessionId = activeSessionId ?? draftSessionId()
    try {
      const selected = await window.barn.sessions.attach(sessionId, kind)
      setAttachments((current) => [...current, ...selected])
      setAttachMenuOpen(false)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function chooseWorkingDirectory(): Promise<void> {
    try {
      const selected = await window.barn.sessions.chooseDirectory()
      if (selected === undefined) return
      if (activeSessionId === undefined) {
        setWorkingDirectory(selected)
        return
      }
      const session = await window.barn.sessions.setWorkingDirectory(activeSessionId, selected)
      setWorkingDirectory(session.workingDirectory)
      setSessions((current) => upsertSession(current, session))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const commandKey = window.barn.platform === 'darwin' ? '⌘' : 'Ctrl'
  const running = pending || activeSession?.status === 'running'
  const visibleSessions = sessionQuery.trim() === ''
    ? sessions
    : sessions.filter((session) => session.title.toLocaleLowerCase().includes(sessionQuery.trim().toLocaleLowerCase()))
  const conversationTitle = activeSession?.title ?? t('conversation.newSession')
  const workingDirectoryLabel = workingDirectory === undefined
    ? t('conversation.chooseWorkingDirectory')
    : workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? workingDirectory
  const workspaceTitle = view === 'tasks' ? t('tasks.title') : conversationTitle
  const needsYouCount = tasks.filter((task) => ['proposed', 'waiting', 'failed'].includes(task.status)).length

  function openSession(sessionId: string): void {
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    setView('conversation')
  }

  function draftSessionId(): string {
    draftSessionIdRef.current ??= crypto.randomUUID()
    return draftSessionIdRef.current
  }

  const appShellClassName = [
    'app-shell',
    window.barn.platform === 'darwin' ? 'platform-darwin' : '',
    sidebarOpen ? '' : 'sidebar-collapsed',
  ].filter(Boolean).join(' ')
  const workspaceShellClassName = 'workspace-shell'

  return (
    <div className={appShellClassName}>
      <aside
        id="app-sidebar"
        className={sidebarOpen ? 'sidebar sidebar-open' : 'sidebar'}
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-content">
          <div className="sidebar-titlebar">
            <TooltipButton
              className="icon-button sidebar-toggle sidebar-toggle-sidebar"
              label={t('sidebar.hide')}
              aria-controls="app-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeft size={16} />
            </TooltipButton>
          </div>

          <div className="sidebar-top">
            <div className="brand-lockup">
              <div className="brand-mark" aria-hidden="true">
                <span />
                <span />
              </div>
              <strong>Barn</strong>
            </div>
            <div
              id="session-search-field"
              className={sessionSearchOpen ? 'session-search open' : 'session-search'}
              role="search"
              aria-label={t('sidebar.filterSessions')}
              aria-hidden={!sessionSearchOpen}
            >
              <input
                ref={sessionSearchInputRef}
                type="search"
                aria-label={t('sidebar.filterSessions')}
                placeholder={t('sidebar.searchSessions')}
                tabIndex={sessionSearchOpen ? 0 : -1}
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  setSessionSearchOpen(false)
                  setSessionQuery('')
                }}
              />
              {sessionQuery.length > 0 && (
                <TooltipButton label={t('sidebar.clearSearch')} onClick={() => setSessionQuery('')}>
                  <X size={12} />
                </TooltipButton>
              )}
            </div>
            <div className="sidebar-actions">
              <TooltipButton
                className={sessionSearchOpen ? 'icon-button active session-search-trigger' : 'icon-button session-search-trigger'}
                label={sessionSearchOpen ? t('sidebar.closeSearch') : t('sidebar.searchSessions')}
                aria-controls="session-search-field"
                aria-expanded={sessionSearchOpen}
                onClick={() => {
                  setSessionSearchOpen(!sessionSearchOpen)
                  if (sessionSearchOpen) setSessionQuery('')
                }}
              >
                <Search size={15} />
              </TooltipButton>
            </div>
          </div>

          <button className="new-session-button" type="button" onClick={startNewSession}>
            <Plus size={15} />
            <span>{t('sidebar.newSession')}</span>
            <kbd>{commandKey} N</kbd>
          </button>
          <button
            className={view === 'tasks' ? 'new-session-button task-nav-button active' : 'new-session-button task-nav-button'}
            type="button"
            aria-current={view === 'tasks' ? 'page' : undefined}
            onClick={() => setView('tasks')}
          >
            <Inbox size={15} />
            <span>{t('tasks.title')}</span>
            {needsYouCount > 0 && <span className="task-nav-count">{needsYouCount}</span>}
          </button>

          <nav className="session-nav" aria-label={t('sidebar.sessions')}>
            <div className="nav-label">
              <span>{t('sidebar.sessions')}</span>
              <span>{visibleSessions.length}</span>
            </div>
            {visibleSessions.length === 0 ? (
              <div className="empty-session-list">
                <Sparkles size={16} />
                <p>{sessionQuery.trim() === '' ? t('sidebar.noSessions') : t('sidebar.noSearchResults')}</p>
              </div>
            ) : (
              <div className="session-list">
                {visibleSessions.map((session) => (
                  <button
                    className={view === 'conversation' && session.id === activeSessionId ? 'session-row active' : 'session-row'}
                    type="button"
                    key={session.id}
                    onClick={() => {
                      openSession(session.id)
                      if (session.id === activeSessionId) void loadSession(session.id)
                    }}
                  >
                    <span>{session.title}</span>
                    <small>{formatSessionTime(session.updatedAt, dateLocale)}</small>
                  </button>
                ))}
              </div>
            )}
          </nav>

          <div className="sidebar-footer">
            <div ref={accountAreaRef} className="account-area">
              <button
                ref={accountTriggerRef}
                className="account-row"
                type="button"
                aria-controls="account-panel"
                aria-expanded={accountOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setAccountOpen(!accountOpen)
                }}
              >
                <span className="account-avatar">
                  <UserRound size={14} />
                </span>
                <span className="account-copy">
                  <strong>{t('sidebar.localAgent')}</strong>
                  <small>{t('sidebar.localWorkspace')}</small>
                </span>
                <ChevronRight size={14} />
              </button>
              <div
                id="account-panel"
                className={accountOpen ? 'account-popover open' : 'account-popover'}
                role="menu"
                aria-label={t('sidebar.accountMenu')}
                aria-hidden={!accountOpen}
                inert={!accountOpen}
              >
                <div className="account-summary">
                  <span>{t('sidebar.workspace')}</span>
                  <strong>{t('sidebar.localWorkspace')}</strong>
                  <small>{t('sidebar.localOnly')}</small>
                </div>
                <button
                  className="account-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false)
                    setSourceSettingsOpen(true)
                  }}
                >
                  <FolderSearch size={14} />
                  <span>{t('sidebar.localSources')}</span>
                  <ChevronRight className="account-menu-chevron" size={13} />
                </button>
                <button
                  className="account-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false)
                    setDiagnosticsOpen(true)
                  }}
                >
                  <Stethoscope size={14} />
                  <span>{t('sidebar.diagnostics')}</span>
                  <ChevronRight className="account-menu-chevron" size={13} />
                </button>
                <button
                  className="account-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false)
                    setSettingsOpen(true)
                  }}
                >
                  <Wrench size={14} />
                  <span>{t('sidebar.models')}</span>
                  <ChevronRight className="account-menu-chevron" size={13} />
                </button>
                <LanguagePicker />
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div className={workspaceShellClassName}>
      <main className="workspace">
        <header className="workspace-header">
          {!sidebarOpen && (
            <TooltipButton
              className="icon-button sidebar-toggle sidebar-toggle-header"
              label={t('sidebar.show')}
              aria-controls="app-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeft size={16} />
            </TooltipButton>
          )}
          <div className="workspace-header-title">
            <div className="workspace-header-copy">
              <h1 title={workspaceTitle}>{workspaceTitle}</h1>
            </div>
          </div>
          <div className="workspace-header-actions" />
        </header>

        <div className="workspace-body">
          {view === 'tasks' ? (
            <TaskCenter
              tasks={tasks}
              loading={tasksLoading}
              error={taskError}
              onOpenSession={openSession}
              onError={setTaskError}
            />
          ) : (
          <section className={messages.length === 0 && liveParts.length === 0 ? 'conversation-surface empty-conversation' : 'conversation-surface chat-surface'}>
            {messages.length === 0 && liveParts.length === 0 ? (
              <div className="empty-center">
                <div className="welcome-mark" aria-hidden="true">
                  <Sparkles size={20} />
                </div>
                <div className="welcome-kicker">{t('conversation.welcomeKicker')}</div>
                <h1>{t('conversation.title')}</h1>
                <p>
                  {t('conversation.subtitle')}
                </p>
                <div className="action-grid">
                  <button type="button" onClick={() => setInput(t('conversation.summarizePrompt'))}>
                    <span className="action-icon blue"><FileText size={17} /></span>
                    <span>{t('conversation.summarizeFiles')}</span>
                  </button>
                  <button type="button" onClick={() => setInput(t('conversation.draftPrompt'))}>
                    <span className="action-icon violet"><Sparkles size={17} /></span>
                    <span>{t('conversation.draftContent')}</span>
                  </button>
                  <button type="button" onClick={() => setInput(t('conversation.inspectFilesPrompt'))}>
                    <span className="action-icon green"><FileSearch size={17} /></span>
                    <span>{t('conversation.inspectFiles')}</span>
                  </button>
                  <button type="button" onClick={() => setInput(t('conversation.organizePrompt'))}>
                    <span className="action-icon orange"><FolderOpen size={17} /></span>
                    <span>{t('conversation.organizeFiles')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="message-list" ref={listRef}>
                {messages.map((message) => (
                  <article
                    aria-label={message.role === 'user' ? t('conversation.userMessage') : t('conversation.barnMessage')}
                    className={`chat-message ${message.role}${message.isError ? ' error' : ''}`}
                    key={message.key}
                  >
                    <ConversationParts
                      parts={message.parts}
                      role={message.role}
                      keyPrefix={message.key}
                    />
                    {message.role === 'user' && message.attachments.length > 0 && (
                      <div className="message-attachments">
                        {message.attachments.map((file) => {
                          const name = attachmentDisplayName(file)
                          return (
                            <span className="message-attachment" key={`${message.key}:${file.path}`} title={name}>
                              {file.kind === 'directory' ? <Folder size={11} /> : <Paperclip size={11} />}
                              <span>{name}</span>
                              {file.size > 0 && <small>{formatFileSize(file.size)}</small>}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </article>
                ))}
                {liveParts.length > 0 && (
                  <article className="chat-message assistant streaming live-turn" aria-label={t('conversation.barnMessage')}>
                    <ConversationParts
                      parts={liveParts}
                      role="assistant"
                      keyPrefix="live"
                    />
                  </article>
                )}
              </div>
            )}

            {error !== undefined && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            <div className="composer-dock">
              <button
                className="composer-project"
                type="button"
                title={workingDirectory ?? t('conversation.managedWorkspace')}
                onClick={() => void chooseWorkingDirectory()}
              >
                <Folder size={13} />
                <span>{workingDirectoryLabel}</span>
                <ChevronDown size={12} />
              </button>
              <div className="composer">
                {attachments.length > 0 && (
                  <div className="attachment-row">
                    {attachments.map((file) => {
                      const name = attachmentDisplayName(file)
                      return (
                        <span className="attachment-chip" key={file.path}>
                          {file.kind === 'directory' ? <Folder size={11} /> : <Paperclip size={11} />}
                          {name}
                          <TooltipButton
                            label={t('conversation.removeAttachment', { name })}
                            onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}
                          >
                            <X size={11} />
                          </TooltipButton>
                        </span>
                      )
                    })}
                  </div>
                )}
                <textarea
                  aria-label={t('conversation.messageBarn')}
                  placeholder={t('conversation.placeholder')}
                  rows={2}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendPrompt()
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <div className="composer-hints">
                    <div className="attach-control" ref={attachAreaRef}>
                      <button
                        className={attachMenuOpen ? 'context-chip active' : 'context-chip'}
                        type="button"
                        aria-label={t('conversation.attach')}
                        aria-expanded={attachMenuOpen}
                        onClick={() => setAttachMenuOpen((current) => !current)}
                      >
                        <Plus size={15} />
                        <span>{t('conversation.attach')}</span>
                      </button>
                      {attachMenuOpen && (
                        <div className="attach-menu" role="menu" aria-label={t('conversation.attachMenu')}>
                          <button type="button" role="menuitem" onClick={() => void attachFiles('files')}>
                            <FilePlus size={14} />
                            <span>{t('conversation.addFiles')}</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => void attachFiles('folder')}>
                            <FolderPlus size={14} />
                            <span>{t('conversation.addFolder')}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="composer-actions">
                    <ModelPicker
                      snapshot={snapshot}
                      onSnapshot={setSnapshot}
                      onConfigure={() => setSettingsOpen(true)}
                      onOpenChange={(open) => {
                        if (open) {
                          setAccountOpen(false)
                        }
                      }}
                      onBusyChange={setModelSelectionBusy}
                    />
                    {running ? (
                      <TooltipButton
                        className="send-button cancel"
                        label={t('conversation.stopResponse')}
                        onClick={() => void cancelRun()}
                      >
                        <Square size={14} />
                      </TooltipButton>
                    ) : (
                      <TooltipButton
                        className="send-button"
                        label={t('conversation.sendMessage')}
                        disabled={modelSelectionBusy}
                        onClick={() => void sendPrompt()}
                      >
                        <ArrowUp size={16} />
                      </TooltipButton>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
          )}

        </div>

        <footer className="workspace-footer">
          <span>{t('footer.localRuntime')}</span>
          <span>
            {capabilities === undefined
              ? t('footer.checkingCapabilities')
              : capabilities.shell.available
                ? t('footer.shellSandbox', { backend: capabilities.shell.backend })
                : t('footer.shellUnavailable')}
            {' · '}
            {snapshot === undefined ? t('footer.loadingProviders') : t('common.providers', { count: snapshot.providers.length })}
            {contextStatus !== undefined && (
              <>
                {' · '}
                {t('footer.context', { percent: Math.min(100, Math.round(contextStatus.tokens / contextStatus.budget * 100)) })}
                {contextStatus.compacted ? ` · ${t('footer.compacted')}` : ''}
              </>
            )}
          </span>
        </footer>
      </main>
      </div>

      {settingsOpen && (
        <ModelSettings
          snapshot={snapshot}
          onSnapshot={setSnapshot}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {sourceSettingsOpen && <SourceSettings onClose={() => setSourceSettingsOpen(false)} />}
      {diagnosticsOpen && <DiagnosticsSettings onClose={() => setDiagnosticsOpen(false)} />}
    </div>
  )
}

function ToolGroup({ tools }: { tools: ToolCallView[] }) {
  const { t } = useTranslation()
  const running = tools.find((tool) => tool.status === 'running')
  const isRunning = running !== undefined
  const hasError = tools.some((tool) => tool.status === 'error')
  const [open, setOpen] = useState(isRunning)

  useEffect(() => {
    if (isRunning) setOpen(true)
  }, [isRunning])

  return (
    <div className={`tool-group${open ? ' open' : ''}`}>
      <button
        aria-expanded={open}
        className={`tool-group-summary${hasError ? ' error' : running !== undefined ? ' running' : ''}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="tool-group-icon">
          {running !== undefined && <LoaderCircle className="spin" size={13} />}
          {running === undefined && hasError && <CircleX size={13} />}
          {running === undefined && !hasError && <Terminal size={13} />}
        </span>
        <span className="tool-group-label">{toolGroupLabel(tools, t)}</span>
        <ChevronRight className="tool-chevron" size={13} />
      </button>
      {open && (
        <div className="tool-group-list">
          {tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
        </div>
      )}
    </div>
  )
}

function ToolRow({ tool }: { tool: ToolCallView }) {
  const { t } = useTranslation()
  return (
    <details className={`tool-row ${tool.status}`} data-part="tool">
      <summary>
        <span className="tool-row-status">
          {tool.status === 'running' && <LoaderCircle className="spin" size={12} />}
          {tool.status === 'success' && <CheckCircle2 size={12} />}
          {tool.status === 'error' && <CircleX size={12} />}
        </span>
        <span className="tool-row-label">{toolActionLabel(tool.name, t)}</span>
        <ChevronRight className="tool-chevron" size={12} />
      </summary>
      <div className="tool-detail-scroll">
        <div className="tool-detail-title">{toolDisplayName(tool.name)}</div>
        {tool.arguments.length > 0 && <pre>{toolArgumentsText(tool)}</pre>}
        {tool.output !== undefined && tool.output.length > 0 && (
          <pre className="tool-detail-output">{tool.output.slice(0, 8_000)}</pre>
        )}
      </div>
    </details>
  )
}

function toolGroupLabel(tools: ToolCallView[], t: ReturnType<typeof useTranslation>['t']): string {
  const running = tools.find((tool) => tool.status === 'running')
  if (running !== undefined) {
    const command = toolCommand(running)
    return command === undefined
      ? t('tools.running', { label: toolActionLabel(running.name, t) })
      : t('tools.runningCommand', { command: truncate(command, 72) })
  }
  if (tools.length === 1) return toolActionLabel(tools[0]?.name ?? '', t)
  if (tools.every((tool) => tool.name === 'shell')) return t('tools.ranCommands', { count: tools.length })
  if (tools.every((tool) => tool.name === 'read_file')) return t('tools.readFiles', { count: tools.length })
  const labels = [...new Set(tools.map((tool) => toolActionLabel(tool.name, t)))]
  return labels.join(' · ')
}

function toolActionLabel(name: string, t: ReturnType<typeof useTranslation>['t']): string {
  switch (name) {
    case 'shell': return t('tools.shell')
    case 'read_file': return t('tools.readFile')
    case 'list_dir': return t('tools.listDir')
    case 'search_files': return t('tools.searchFiles')
    case 'view_image': return t('tools.viewImage')
    default: return t('tools.ranTool', { name })
  }
}

function toolDisplayName(name: string): string {
  return name.split('_').map((part) => part.length === 0 ? part : `${part[0]?.toUpperCase()}${part.slice(1)}`).join(' ')
}

function toolCommand(tool: ToolCallView): string | undefined {
  const parsed = toolArgumentsRecord(tool)
  return typeof parsed?.command === 'string' && parsed.command.trim().length > 0
    ? parsed.command.trim()
    : undefined
}

function toolArgumentsText(tool: ToolCallView): string {
  const command = toolCommand(tool)
  if (command !== undefined) return `$ ${command}`
  const parsed = toolArgumentsRecord(tool)
  if (parsed === undefined) return tool.arguments
  return JSON.stringify(parsed, null, 2)
}

function toolArgumentsRecord(tool: ToolCallView): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(tool.arguments)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function ConversationParts({
  parts,
  role,
  keyPrefix,
}: {
  parts: ConversationPart[]
  role: ChatMessage['role']
  keyPrefix: string
}) {
  const { t } = useTranslation()
  const displayParts = groupConversationParts(parts)
  return (
    <div className="conversation-parts">
      {displayParts.map((part, index) => {
        if (part.type === 'thinking') {
          return (
            <details
              className={`conversation-part thinking-block${part.streaming === true ? ' streaming' : ''}`}
              data-part="thinking"
              key={`${keyPrefix}:thinking:${index}`}
              open={part.streaming === true ? true : undefined}
            >
              <summary>
                <Brain size={12} />
                <span>{part.streaming === true ? t('conversation.thinking') : t('conversation.thoughtProcess')}</span>
              </summary>
              <div className="thinking-copy" aria-live={part.streaming === true ? 'polite' : undefined}>
                {part.text}
              </div>
            </details>
          )
        }
        if (part.type === 'tool-group') {
          return (
            <div
              className="conversation-part conversation-tool-group"
              data-part="tool-group"
              key={`${keyPrefix}:tools:${part.key}`}
            >
              <ToolGroup tools={part.tools} />
            </div>
          )
        }
        return (
          <div
            className={`conversation-part conversation-text${part.streaming === true ? ' streaming' : ''}`}
            data-part="text"
            key={`${keyPrefix}:text:${index}`}
          >
            {role === 'assistant' ? (
              <Streamdown
                className="message-copy assistant-markdown"
                components={STREAMDOWN_COMPONENTS}
                animated={part.streaming === true}
                isAnimating={part.streaming === true}
              >
                {part.text}
              </Streamdown>
            ) : (
              <div className="message-copy">{part.text}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function upsertSession(current: SessionSummary[], session: SessionSummary): SessionSummary[] {
  const next = current.filter((item) => item.id !== session.id)
  return [session, ...next].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function upsertTask(current: Task[], task: Task): Task[] {
  return [task, ...current.filter((item) => item.id !== task.id)]
}

function errorMessage(reason: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  return reason instanceof Error ? reason.message : t('conversation.somethingWentWrong')
}

function formatSessionTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${Math.round(bytes / (1_024 * 1_024) * 10) / 10} MB`
}
