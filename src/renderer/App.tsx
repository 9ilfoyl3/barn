import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import 'streamdown/styles.css'
import {
  Archive,
  ChevronRight,
  ChevronDown,
  FileSearch,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  Globe2,
  Inbox,
  Search,
  Settings2,
  Wrench,
  PanelLeft,
  Paperclip,
  Pin,
  Plus,
  Sparkles,
  Stethoscope,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import type {
  ApprovalRequest,
  AttachmentDescriptor,
  BrowserState,
  ModelConfigSnapshot,
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
import { SettingsPage } from './SettingsPage'
import { AttachmentStrip } from './AttachmentStrip'
import { AgentScreen } from './AgentScreen'
import { BrowserPanel, type BrowserQuickAction } from './BrowserPanel'
import { UtilityPanel, type UtilityTab, type UtilityTabType } from './UtilityPanel'
import { ConversationParts, PendingThinking } from './ConversationParts'
import './composer-workspace.css'
import './browser-panel.css'
import { TaskCenter } from './TaskCenter'
import { initializeAppLanguage } from './i18n'
import { TooltipButton } from './components/TooltipButton'
import { MessageBubble, MessageBubbleGroup } from '@/components/beui/components/agents/message-bubble'
import { PromptInput } from '@/components/beui/components/agents/prompt-input'
import {
  applyLiveEvent,
  messagesFromEvents,
  type ChatMessage,
  type ConversationPart,
} from './conversation'

export function App() {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [workingDirectory, setWorkingDirectory] = useState<string>()
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const [accountOpen, setAccountOpen] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [view, setView] = useState<'conversation' | 'tasks' | 'settings'>('conversation')
  const [tasks, setTasks] = useState<Task[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [taskError, setTaskError] = useState<string>()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [utilityOpen, setUtilityOpen] = useState(false)
  const [utilityTabs, setUtilityTabs] = useState<UtilityTab[]>([])
  const [activeUtilityTabId, setActiveUtilityTabId] = useState<string>()
  const [browserState, setBrowserState] = useState<BrowserState>({
    open: false,
    visible: false,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    tabs: [],
    downloads: [],
    history: [],
  })
  const [agentScreenPreview, setAgentScreenPreview] = useState<string>()
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const listRef = useRef<HTMLElement>(null)
  const sessionSearchInputRef = useRef<HTMLInputElement>(null)
  const accountAreaRef = useRef<HTMLDivElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)
  const sideChatCounterRef = useRef(0)

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
        const initialSessionId = value.find((session) => session.archivedAt === undefined)?.id
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
    setStopping(false)
    if (activeSessionId === undefined) return
    void loadSession(activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    if (activeSessionId === undefined) return
    const session = sessions.find((item) => item.id === activeSessionId)
    if (session?.workingDirectory !== undefined) setWorkingDirectory(session.workingDirectory)
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (activeSessionId === undefined) return
    const session = sessions.find((item) => item.id === activeSessionId)
    if (session?.hasUnreadResult !== true) return
    setSessions((current) => current.map((item) => (
      item.id === activeSessionId ? { ...item, hasUnreadResult: false } : item
    )))
    void window.barn.sessions.markRead(activeSessionId)
      .then((updated) => setSessions((current) => upsertSession(current, updated)))
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
  }, [activeSessionId, sessions])

  useEffect(() => {
    return window.barn.sessions.onEvent(handleLiveEvent)
  }, [])
  useEffect(() => {
    const upsert = (approval: ApprovalRequest): void => {
      setPendingApprovals((current) => {
        const rest = current.filter((entry) => entry.id !== approval.id)
        return approval.status === 'pending' ? [approval, ...rest] : rest
      })
    }
    const unsubscribe = window.barn.approvals.onChange(upsert)
    void window.barn.approvals.listPending().then((approvals) => setPendingApprovals(approvals))
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.barn.browser.onEvent((event) => {
      setBrowserState(event.state)
      setBrowserOpen(event.state.open)
      if (event.state.open) setUtilityOpen(false)
    })
    void window.barn.browser.getState()
      .then((state) => {
        setBrowserState(state)
        setBrowserOpen(state.open)
      })
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    return unsubscribe
  }, [])

  useEffect(() => {
    if (browserOpen || browserState.url === 'about:blank') return
    const timer = setTimeout(() => {
      void window.barn.browser.capture()
        .then(setAgentScreenPreview)
        .catch(() => undefined)
    }, 320)
    return () => clearTimeout(timer)
  }, [browserOpen, browserState.loading, browserState.title, browserState.url])


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
      if (event.session.id === sessionId) {
        setPending(event.session.status === 'running')
        if (event.session.status !== 'running') setStopping(false)
        void loadSession(sessionId)
      }
      return
    }
    if (event.sessionId !== sessionId) return

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
        setStopping(false)
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
    setPending(false)
    setStopping(false)
    setError(undefined)
  }

  async function sendPrompt(): Promise<void> {
    const text = input.trim()
    if (text.length === 0 || pending || modelSelectionBusy || activeSession?.archivedAt !== undefined) return
    const isNewSession = activeSessionId === undefined
    const sessionId = activeSessionId ?? draftSessionId()

    const filesToSend = attachments
    try {
      if (isNewSession) await window.barn.sessions.create(sessionId)
      activeSessionIdRef.current = sessionId
      setActiveSessionId(sessionId)
      setPending(true)
      setStopping(false)
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
    if (sessionId === undefined || stopping) return
    setStopping(true)
    try {
      await window.barn.sessions.cancel(sessionId)
    } catch (reason) {
      setStopping(false)
      setError(errorMessage(reason, t))
    }
  }

  async function attachFiles(): Promise<void> {
    const sessionId = activeSessionId ?? draftSessionId()
    try {
      const selected = await window.barn.sessions.attach(sessionId)
      setAttachments((current) => [...current, ...selected])
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function clearWorkingDirectory(): Promise<void> {
    if (workingDirectory === undefined) return
    try {
      if (activeSessionId === undefined) {
        setWorkingDirectory(undefined)
        return
      }
      const session = await window.barn.sessions.clearWorkingDirectory(activeSessionId)
      setWorkingDirectory(undefined)
      setSessions((current) => upsertSession(current, session))
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

  async function setSessionPinned(session: SessionSummary, pinned: boolean): Promise<void> {
    keepSessionSidebarAnchored()
    try {
      const updated = await window.barn.sessions.setPinned(session.id, pinned)
      setSessions((current) => upsertSession(current, updated))
      setAnnouncement(pinned ? t('sidebar.sessionPinned') : t('sidebar.sessionUnpinned'))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function archiveSession(sessionId: string): Promise<void> {
    keepSessionSidebarAnchored()
    try {
      const updated = await window.barn.sessions.setArchived(sessionId, true)
      setSessions((current) => upsertSession(current, updated))
      if (activeSessionId === sessionId) {
        const fallback = sortSessions(sessions.filter((session) => (
          session.id !== sessionId && session.archivedAt === undefined
        )))[0]
        if (fallback === undefined) startNewSession()
        else openSession(fallback.id)
      }
      setAnnouncement(t('sidebar.sessionArchived'))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function unarchiveSession(sessionId: string): Promise<void> {
    keepSessionSidebarAnchored()
    try {
      const updated = await window.barn.sessions.setArchived(sessionId, false)
      setSessions((current) => upsertSession(current, updated))
      setAnnouncement(t('appSettings.unarchived'))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function toggleBrowser(): Promise<void> {
    try {
      const state = browserOpen
        ? await window.barn.browser.close()
        : await window.barn.browser.open()
      setBrowserState(state)
      setBrowserOpen(state.open)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function closeBrowser(): Promise<void> {
    try {
      const state = await window.barn.browser.close()
      setBrowserState(state)
      setBrowserOpen(false)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function navigateBrowser(url: string): Promise<void> {
    try {
      const state = await window.barn.browser.navigate(url)
      setBrowserState(state)
      setBrowserOpen(state.open)
    } catch (reason) {
      setError(errorMessage(reason, t))
      throw reason
    }
  }

  async function navigateFromUtility(url: string): Promise<void> {
    await navigateBrowser(url)
    setUtilityOpen(false)
  }

  async function browserHistory(direction: 'back' | 'forward'): Promise<void> {
    try {
      const state = direction === 'back'
        ? await window.barn.browser.back()
        : await window.barn.browser.forward()
      setBrowserState(state)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  function handleBrowserQuickAction(action: BrowserQuickAction): void {
    if (action === 'files') {
      void attachFiles()
      return
    }
    void openUtilityTab(action === 'terminal' ? 'terminal' : 'side-chat')
  }

  async function openUtilityTab(type: UtilityTabType): Promise<void> {
    let tab: UtilityTab | undefined
    if (type === 'terminal') {
      tab = utilityTabs.find((candidate) => candidate.type === 'terminal')
      if (tab === undefined) {
        tab = { id: crypto.randomUUID(), type: 'terminal', title: t('browser.terminal') }
        setUtilityTabs((current) => [...current, tab!])
      }
    } else if (type === 'empty') {
      tab = { id: crypto.randomUUID(), type: 'empty', title: t('browser.newTab') }
      setUtilityTabs((current) => [...current, tab!])
    } else {
      sideChatCounterRef.current += 1
      const count = sideChatCounterRef.current
      const parentSessionId = activeSessionIdRef.current ?? draftSessionId()
      tab = {
        id: crypto.randomUUID(),
        type: 'side-chat',
        title: count === 1 ? t('browser.sideChat') : `${t('browser.sideChat')} ${count}`,
        parentSessionId,
      }
      setUtilityTabs((current) => [...current, tab!])
    }
    setActiveUtilityTabId(tab.id)
    setUtilityOpen(true)
    if (browserOpen) {
      try {
        const state = await window.barn.browser.close()
        setBrowserState(state)
        setBrowserOpen(false)
      } catch (reason) {
        setError(errorMessage(reason, t))
      }
    }
  }

  function closeUtilityTab(tabId: string): void {
    const closing = utilityTabs.find((tab) => tab.id === tabId)
    const index = utilityTabs.findIndex((tab) => tab.id === tabId)
    const next = utilityTabs.filter((tab) => tab.id !== tabId)
    setUtilityTabs(next)
    if (closing?.type === 'side-chat') {
      void window.barn.sessions.setArchived(tabId, true).catch(() => undefined)
    }
    if (activeUtilityTabId === tabId) {
      const fallback = next[Math.min(index, next.length - 1)]
      setActiveUtilityTabId(fallback?.id)
      if (fallback === undefined) setUtilityOpen(false)
    }
  }

  async function newBrowserTab(): Promise<void> {
    try {
      const state = await window.barn.browser.newTab()
      setBrowserState(state)
      setBrowserOpen(state.open)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function activateBrowserTab(tabId: string): Promise<void> {
    try {
      setBrowserState(await window.barn.browser.activateTab(tabId))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function resolveBrowserApproval(decision: 'approved' | 'denied'): Promise<void> {
    const approval = pendingApprovals.find((entry) => entry.title === 'Approve browser action')
    if (approval === undefined) return
    try {
      await window.barn.approvals.resolve(approval.id, decision)
      setPendingApprovals((current) => current.filter((entry) => entry.id !== approval.id))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function revealBrowserDownload(downloadId: string): Promise<void> {
    try {
      await window.barn.browser.revealDownload(downloadId)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function closeBrowserTab(tabId: string): Promise<void> {
    try {
      const state = await window.barn.browser.closeTab(tabId)
      setBrowserState(state)
      setBrowserOpen(state.open)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function reloadBrowser(): Promise<void> {
    try {
      setBrowserState(await window.barn.browser.reload())
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const commandKey = window.barn.platform === 'darwin' ? '⌘' : 'Ctrl'
  const running = pending || activeSession?.status === 'running'
  const sideChatSessionIds = new Set(utilityTabs.filter((tab) => tab.type === 'side-chat').map((tab) => tab.id))
  const rightPanelOpen = browserOpen || utilityOpen
  const activeSessions = sortSessions(sessions.filter((session) => (
    session.archivedAt === undefined && session.parentSessionId === undefined && !sideChatSessionIds.has(session.id)
  )))
  const archivedSessions = sortSessions(sessions.filter((session) => (
    session.archivedAt !== undefined && session.parentSessionId === undefined && !sideChatSessionIds.has(session.id)
  )))
  const normalizedSessionQuery = sessionQuery.trim().toLocaleLowerCase()
  const visibleSessions = normalizedSessionQuery === ''
    ? activeSessions
    : activeSessions.filter((session) => session.title.toLocaleLowerCase().includes(normalizedSessionQuery))
  const pinnedSessions = visibleSessions.filter((session) => session.pinned)
  const recentSessions = visibleSessions.filter((session) => !session.pinned)
  const activeSessionIsArchived = activeSession?.archivedAt !== undefined
  const conversationTitle = activeSession?.title ?? t('conversation.newSession')
  const workingDirectoryLabel = workingDirectory === undefined
    ? t('conversation.chooseWorkingDirectory')
    : workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? workingDirectory
  const hasBrowserOperation = [...messages.flatMap((message) => message.parts), ...liveParts]
    .some((part) => part.type === 'tool' && part.tool.name.startsWith('browser_'))
  const browserApproval = pendingApprovals.find((approval) => approval.title === 'Approve browser action')
  const workspaceTitle = view === 'tasks'
    ? t('tasks.title')
    : view === 'settings'
      ? t('sidebar.settings')
      : conversationTitle
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

  function renderSessionRows(items: SessionSummary[]) {
    return items.map((session) => (
      <SessionRow
        active={view === 'conversation' && session.id === activeSessionId}
        key={session.id}
        onArchive={() => void archiveSession(session.id)}
        onOpen={() => openSession(session.id)}
        onTogglePinned={() => void setSessionPinned(session, !session.pinned)}
        session={session}
      />
    ))
  }

  const appShellClassName = [
    'app-shell',
    window.barn.platform === 'darwin' ? 'platform-darwin' : '',
    sidebarOpen ? '' : 'sidebar-collapsed',
  ].filter(Boolean).join(' ')
  const workspaceShellClassName = rightPanelOpen ? 'workspace-shell browser-open' : 'workspace-shell'
  const showAgentScreen = view === 'conversation' && !rightPanelOpen && hasBrowserOperation
  const workspaceBodyClassName = showAgentScreen ? 'workspace-body agent-screen-open' : 'workspace-body'

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
            <div className="session-list">
              {pinnedSessions.length > 0 && (
                <>
                  <div className="nav-label">
                    <span>{t('sidebar.pinned')}</span>
                    <span>{pinnedSessions.length}</span>
                  </div>
                  <div className="session-group" data-group="pinned">
                    {renderSessionRows(pinnedSessions)}
                  </div>
                </>
              )}
              <div className="nav-label session-recent-label">
                <span>{t('sidebar.recent')}</span>
                <span>{recentSessions.length}</span>
              </div>
              {recentSessions.length > 0 && (
                <div className="session-group" data-group="recent">
                  {renderSessionRows(recentSessions)}
                </div>
              )}
              {visibleSessions.length === 0 && (
                <div className="empty-session-list">
                  <Sparkles size={16} />
                  <p>
                    {sessionQuery.trim() !== ''
                      ? t('sidebar.noSearchResults')
                      : t('sidebar.noSessions')}
                  </p>
                </div>
              )}
            </div>
          </nav>

          <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>

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
                    keepSessionSidebarAnchored()
                    setView('settings')
                  }}
                >
                  <Settings2 size={14} />
                  <span>{t('sidebar.settings')}</span>
                  <ChevronRight className="account-menu-chevron" size={13} />
                </button>
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

      <div className={workspaceShellClassName} data-testid="workspace-shell">
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
          <div className="workspace-header-actions">
            {!rightPanelOpen && (
              <TooltipButton
                className="icon-button browser-toggle"
                label={t('browser.open')}
                aria-pressed={false}
                onClick={() => void toggleBrowser()}
              >
                <Globe2 size={15} />
              </TooltipButton>
            )}
          </div>
        </header>

        <div className={workspaceBodyClassName}>
          {view === 'settings' ? (
            <SettingsPage
              sessions={archivedSessions}
              onUnarchive={(sessionId) => unarchiveSession(sessionId)}
            />
          ) : view === 'tasks' ? (
            <TaskCenter
              tasks={tasks}
              loading={tasksLoading}
              error={taskError}
              onOpenSession={openSession}
              onError={setTaskError}
            />
          ) : (
            <div className="conversation-view">
              <section
                ref={listRef}
                className={messages.length === 0 && liveParts.length === 0 && !running ? 'conversation-surface empty-conversation' : 'conversation-surface chat-surface'}
              >
                {messages.length === 0 && liveParts.length === 0 && !running ? (
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
                      </MessageBubble>
                    ))}
                    {running && liveParts.length === 0 && (
                      <MessageBubble
                        aria-label={t('conversation.barnMessage')}
                        className="chat-message assistant live-turn"
                        role="article"
                        variant="ghost"
                      >
                        <PendingThinking />
                      </MessageBubble>
                    )}
                    {liveParts.length > 0 && (
                      <MessageBubble
                        aria-label={t('conversation.barnMessage')}
                        className="chat-message assistant streaming live-turn"
                        role="article"
                        variant="ghost"
                      >
                        <ConversationParts
                          parts={liveParts}
                          role="assistant"
                          keyPrefix="live"
                        />
                      </MessageBubble>
                    )}
                  </MessageBubbleGroup>
                )}

                {error !== undefined && (
                  <div className="error-banner" role="alert">
                    {error}
                  </div>
                )}
              </section>

              <div className="composer-dock">
                <div className="composer-project">
                  {workingDirectory === undefined ? (
                    <span className="composer-project-icon">
                      <Folder size={13} />
                    </span>
                  ) : (
                    <button
                      className="composer-project-icon composer-project-delete"
                      type="button"
                      disabled={activeSessionIsArchived}
                      aria-label={t('conversation.clearWorkingDirectory')}
                      title={t('conversation.clearWorkingDirectory')}
                      onClick={() => void clearWorkingDirectory()}
                    >
                      <Folder className="folder-icon" size={13} />
                      <Trash2 className="delete-icon" size={13} />
                    </button>
                  )}
                  <button
                    className="composer-project-picker"
                    type="button"
                    disabled={activeSessionIsArchived}
                    title={workingDirectory ?? t('conversation.managedWorkspace')}
                    aria-label={t('conversation.chooseWorkingDirectory')}
                    onClick={() => void chooseWorkingDirectory()}
                  >
                    <span>{workingDirectoryLabel}</span>
                    <ChevronDown size={12} />
                  </button>
                </div>
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
                    aria-label={t('conversation.messageBarn')}
                    className="barn-prompt-input"
                    disabled={modelSelectionBusy || activeSessionIsArchived}
                    leadingAction={(
                      <ModelPicker
                        snapshot={snapshot}
                        onSnapshot={setSnapshot}
                        onConfigure={() => setSettingsOpen(true)}
                        onOpenChange={(open) => {
                          if (open) setAccountOpen(false)
                        }}
                        onBusyChange={setModelSelectionBusy}
                      />
                    )}
                    loading={running}
                    maxRows={8}
                    minRows={2}
                    onAction={(action) => {
                      if (action === 'attach') void attachFiles()
                    }}
                    onStop={() => void cancelRun()}
                    onSubmit={() => void sendPrompt()}
                    onValueChange={setInput}
                    placeholder={activeSessionIsArchived
                      ? t('conversation.archivedPlaceholder')
                      : t('conversation.placeholder')}
                    sendLabel={t('conversation.sendMessage')}
                    stopLabel={t('conversation.stopResponse')}
                    stopping={stopping}
                    stoppingLabel={t('conversation.stoppingResponse')}
                    value={input}
                  />
                </div>
              </div>
            </div>
          )}

          {showAgentScreen && (
            <AgentScreen
              preview={agentScreenPreview}
              onOpenBrowser={() => void toggleBrowser()}
            />
          )}

        </div>
      </main>

      {browserOpen && !utilityOpen && (
        <BrowserPanel
          state={browserState}
          onBack={() => browserHistory('back')}
          onClose={closeBrowser}
          onForward={() => browserHistory('forward')}
          onNavigate={navigateBrowser}
          onReload={reloadBrowser}
          onNewTab={newBrowserTab}
          onActivateTab={activateBrowserTab}
          onCloseTab={closeBrowserTab}
          onRevealDownload={revealBrowserDownload}
          onQuickAction={handleBrowserQuickAction}
          approval={browserApproval}
          onResolveApproval={resolveBrowserApproval}
        />
      )}
      {utilityOpen && (
        <UtilityPanel
          tabs={utilityTabs}
          activeTabId={activeUtilityTabId}
          workingDirectory={workingDirectory}
          browserHistory={browserState.history}
          onActivate={setActiveUtilityTabId}
          onCloseTab={closeUtilityTab}
          onAddTab={() => void openUtilityTab('empty')}
          onNavigate={navigateFromUtility}
          onQuickAction={handleBrowserQuickAction}
          onConfigureModel={() => setSettingsOpen(true)}
          onClose={() => setUtilityOpen(false)}
          onError={(message) => setError(message)}
        />
      )}
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

function upsertSession(current: SessionSummary[], session: SessionSummary): SessionSummary[] {
  const next = current.filter((item) => item.id !== session.id)
  return sortSessions([session, ...next])
}

function sortSessions(current: SessionSummary[]): SessionSummary[] {
  return current.toSorted((a, b) => {
    const archivedOrder = Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined)
    if (archivedOrder !== 0) return archivedOrder
    const pinnedOrder = Number(b.pinned) - Number(a.pinned)
    if (pinnedOrder !== 0) return pinnedOrder
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

function keepSessionSidebarAnchored(): void {
  requestAnimationFrame(() => {
    const sidebar = document.getElementById('app-sidebar')
    if (sidebar !== null) sidebar.scrollLeft = 0
  })
}

function upsertTask(current: Task[], task: Task): Task[] {
  return [task, ...current.filter((item) => item.id !== task.id)]
}

function errorMessage(reason: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  return reason instanceof Error ? reason.message : t('conversation.somethingWentWrong')
}

interface SessionRowProps {
  session: SessionSummary
  active: boolean
  onOpen: () => void
  onTogglePinned: () => void
  onArchive: () => void
}

function SessionRow({
  session,
  active,
  onOpen,
  onTogglePinned,
  onArchive,
}: SessionRowProps) {
  const { t } = useTranslation()
  const statusLabel = session.status === 'running'
    ? t('sidebar.sessionRunning')
    : session.status === 'failed'
      ? t('sidebar.sessionFailed')
      : t('sidebar.sessionComplete')
  const className = [
    'session-row',
    active ? 'active' : '',
    session.pinned ? 'pinned' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className} data-session-id={session.id}>
      <button
        className="session-row-main"
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
      >
        <SessionRowTitle title={session.title} />
      </button>
      {(session.status === 'running' || session.hasUnreadResult) && (
        <span
          className={`session-row-status ${session.status}`}
          role="status"
          aria-label={statusLabel}
          title={statusLabel}
        >
          {session.status === 'running'
            ? <span className="session-row-status-spinner" />
            : <span className="session-row-status-dot" />}
        </span>
      )}
      <div className="session-row-actions">
        <TooltipButton
          className="session-row-action"
          label={session.pinned ? t('sidebar.unpinSession') : t('sidebar.pinSession')}
          tooltipSide="top"
          aria-pressed={session.pinned}
          onClick={onTogglePinned}
        >
          <Pin size={13} fill={session.pinned ? 'currentColor' : 'none'} />
        </TooltipButton>
        <TooltipButton
          className="session-row-action"
          label={t('sidebar.archiveSession')}
          tooltipSide="top"
          onClick={onArchive}
        >
          <Archive size={13} />
        </TooltipButton>
      </div>
    </div>
  )
}

function SessionRowTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = viewport?.firstElementChild
    if (!viewport || !(content instanceof HTMLElement)) return

    const measure = (): void => {
      const distance = Math.max(0, content.scrollWidth - viewport.clientWidth)
      viewport.toggleAttribute('data-scrollable', distance > 1)
      viewport.style.setProperty('--session-title-shift', `${distance}px`)
      viewport.style.setProperty('--session-title-duration', `${Math.min(7, Math.max(2.6, distance / 32 + 2.6))}s`)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [title])

  return (
    <span ref={viewportRef} className="session-title" title={title}>
      <span className="session-title-text">{title}</span>
    </span>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${Math.round(bytes / (1_024 * 1_024) * 10) / 10} MB`
}
