import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import 'streamdown/styles.css'
import {
  Clock3,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderSearch,
  Globe2,
  Inbox,
  Search,
  Sparkles,
  Home,
  LayoutGrid,
  ListTodo,
  Plug,
  Settings2,
  Paperclip,
  Stethoscope,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import type {
  ApprovalRequest,
  AttachmentDescriptor,
  BrowserState,
  ModelConfigSnapshot,
  SessionLiveEvent,
  RouterRequest,
  SessionSummary,
  Task,
  TaskLiveEvent,
  VisibleMessage,
} from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'
import { ModelSettings } from './ModelSettings'
import { ModelPicker } from './ModelPicker'
import { LanguagePicker } from './LanguagePicker'
import { SourceSettings } from './SourceSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { SettingsPage } from './SettingsPage'
import { AttachmentStrip } from './AttachmentStrip'
import { BrowserPanel, type BrowserQuickAction } from './BrowserPanel'
import { UtilityPanel, type UtilityTab, type UtilityTabType } from './UtilityPanel'
import { ConversationParts, PendingThinking } from './ConversationParts'
import { AssistantResult } from './AssistantResult'
import './composer-workspace.css'
import './browser-panel.css'
import { TaskCenter } from './TaskCenter'
import { TodayPanel } from './TodayPanel'
import { TaskRail } from './TaskRail'
import { TaskDetailPage } from './TaskDetailPage'
import { CommandPalette } from './CommandPalette'
import './secretary.css'
import { initializeAppLanguage } from './i18n'
import { TooltipButton } from './components/TooltipButton'
import { MessageBubble, MessageBubbleGroup } from '@/components/beui/components/agents/message-bubble'
import { PromptInput } from '@/components/beui/components/agents/prompt-input'
import {
  applyLiveEvent,
  mergeThreadAndSessionMessages,
  messagesFromEvents,
  type ChatMessage,
  type ConversationPart,
} from './conversation'

function railButtonClassName(active: boolean): string {
  return active ? 'app-rail-button active' : 'app-rail-button'
}

export function App() {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [threadMessages, setThreadMessages] = useState<VisibleMessage[]>([])
  const [routerRequests, setRouterRequests] = useState<RouterRequest[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [workingDirectory, setWorkingDirectory] = useState<string>()
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [accountOpen, setAccountOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [view, setView] = useState<'conversation' | 'tasks' | 'task-detail' | 'settings'>('conversation')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
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
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const listRef = useRef<HTMLElement>(null)
  const accountAreaRef = useRef<HTMLDivElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)

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
      .then(setSessions)
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    void window.barn.tasks.list()
      .then((value) => {
        setTasks(value)
        setTaskError(undefined)
      })
      .catch((reason: unknown) => setTaskError(errorMessage(reason, t)))
      .finally(() => setTasksLoading(false))
    const unsubscribeTasks = window.barn.tasks.onEvent(handleTaskEvent)
    const unsubscribeThread = window.barn.threads.onEvent((event) => {
      setThreadMessages((current) => upsertVisibleMessage(current, event.message))
    })
    void window.barn.threads.getSnapshot()
      .then((threadSnapshot) => setThreadMessages(threadSnapshot.messages))
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    const unsubscribeRouter = window.barn.router.onEvent((event) => {
      if (event.type === 'router.request-updated') {
        setRouterRequests((current) => upsertRouterRequest(current, event.request))
        return
      }
      if (event.type === 'router.execution-started') {
        activeSessionIdRef.current = event.executionSessionId
        setActiveSessionId(event.executionSessionId)
        setPending(true)
        setLiveParts([])
        return
      }
      setPending(false)
    })
    void window.barn.router.getSnapshot()
      .then((routerSnapshot) => setRouterRequests(routerSnapshot.requests))
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    return () => {
      unsubscribeTheme()
      unsubscribeTasks()
      unsubscribeThread()
      unsubscribeRouter()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((current) => !current)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
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
      setBrowserOpen(event.state.visible)
      if (event.state.visible) setUtilityOpen(false)
    })
    void window.barn.browser.getState()
      .then((state) => {
        setBrowserState(state)
        setBrowserOpen(state.visible)
      })
      .catch((reason: unknown) => setError(errorMessage(reason, t)))
    return unsubscribe
  }, [])

  useEffect(() => window.barn.lifecycle.onShowTasks(() => setView('tasks')), [])

  useEffect(() => {
    const element = listRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [messages, liveParts, threadMessages])

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
        void loadSession(sessionId).finally(() => setLiveParts([]))
        if (event.status === 'failed') setError(event.error ?? t('conversation.runFailed'))
      }
    }
  }

  async function sendPrompt(): Promise<void> {
    const text = input.trim()
    if (text.length === 0 || modelSelectionBusy) return
    const filesToSend = attachments
    const clientMessageId = crypto.randomUUID()
    setInput('')
    setAttachments([])
    setError(undefined)
    try {
      await window.barn.router.submit({
        text,
        clientMessageId,
        ...(filesToSend.length === 0 ? {} : { attachments: filesToSend }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        locale: document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en',
      })
    } catch (reason) {
      setInput(text)
      setAttachments(filesToSend)
      setError(errorMessage(reason, t))
    }
  }

  async function cancelRouterRequest(requestId: string): Promise<void> {
    try {
      const request = await window.barn.router.cancel(requestId)
      setRouterRequests((current) => upsertRouterRequest(current, request))
    } catch (reason) {
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

  async function refreshTasks(): Promise<void> {
    setTasksLoading(true)
    try {
      setTasks(await window.barn.tasks.list())
      setTaskError(undefined)
    } catch (reason) {
      setTaskError(errorMessage(reason, t))
    } finally {
      setTasksLoading(false)
    }
  }

  async function openResultLink(url: string): Promise<void> {
    try {
      const state = await window.barn.browser.open(url)
      setBrowserState(state)
      setBrowserOpen(state.open)
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
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
    if (action === 'terminal') void openUtilityTab('terminal')
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
    }
    if (tab === undefined) return
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
    const index = utilityTabs.findIndex((tab) => tab.id === tabId)
    const next = utilityTabs.filter((tab) => tab.id !== tabId)
    setUtilityTabs(next)
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
  const liveText = new Set(liveParts.flatMap((part) => part.type === 'text' ? [part.text.trim()] : []))
  const displayMessages = threadMessages.length > 0
    ? mergeThreadAndSessionMessages(threadMessages, messages).filter((message) => (
      liveParts.length === 0
      || !liveText.has(message.parts.flatMap((part) => part.type === 'text' ? [part.text.trim()] : []).join('\n'))
    ))
    : messages
  const displayLiveParts = liveParts
  const rightPanelOpen = browserOpen || utilityOpen
  const activeSessionIsArchived = activeSession?.archivedAt !== undefined
  const workingDirectoryLabel = workingDirectory === undefined
    ? t('conversation.chooseWorkingDirectory')
    : workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? workingDirectory
  const browserApproval = pendingApprovals.find((approval) => approval.title === 'Approve browser action')
  const needsYouCount = tasks.filter((task) => ['proposed', 'waiting', 'failed'].includes(task.status)).length
  const routerQueuedCount = routerRequests.filter((request) => request.status === 'queued').length

  function openTask(task: Task): void {
    setCommandOpen(false)
    setSelectedTaskId(task.id)
    setView('task-detail')
  }

  function routerRequestStatusLabel(request: RouterRequest): string {
    if (request.status === 'queued') return t('router.queued')
    if (request.status === 'routing') return t('router.routing')
    if (request.status === 'cancelled') return t('router.cancelled')
    if (request.status === 'failed') return t('router.failed')
    if (request.decisionKind === 'create_task') return t('router.taskQueued')
    return t('router.completed')
  }

  function draftSessionId(): string {
    draftSessionIdRef.current ??= crypto.randomUUID()
    return draftSessionIdRef.current
  }

  const appShellClassName = [
    'app-shell',
    'secretary-shell',
    window.barn.platform === 'darwin' ? 'platform-darwin' : '',
  ].filter(Boolean).join(' ')
  const workspaceShellClassName = rightPanelOpen ? 'workspace-shell browser-open' : 'workspace-shell'
  const workspaceBodyClassName = [
    'workspace-body',
    view === 'conversation' && !rightPanelOpen ? 'secretary-home' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={appShellClassName}>
      <header className="app-topbar workspace-header">
        <div className="app-topbar-leading" aria-hidden="true" />
        <button className="secretary-search" type="button" onClick={() => setCommandOpen(true)}>
          <Search size={15} aria-hidden="true" />
          <span>{t('secretary.search')}</span>
          <kbd>{commandKey} K</kbd>
        </button>
        <div className="app-topbar-actions">
          {!rightPanelOpen && (
            <TooltipButton
              className="icon-button secretary-action browser-toggle"
              label={t('browser.open')}
              aria-pressed={false}
              onClick={() => void toggleBrowser()}
            >
              <Globe2 size={15} />
            </TooltipButton>
          )}
          <TooltipButton
            className="icon-button secretary-action"
            label={t('sidebar.settings')}
            onClick={() => setView('settings')}
          >
            <Clock3 size={15} />
          </TooltipButton>
        </div>
      </header>

      <aside id="app-sidebar" className="app-rail" aria-label={t('navigation.label')}>
        <nav className="app-rail-nav" aria-label={t('navigation.label')}>
          <button
            className={railButtonClassName(view === 'conversation')}
            type="button"
            aria-current={view === 'conversation' ? 'page' : undefined}
            onClick={() => setView('conversation')}
          >
            <Home size={19} aria-hidden="true" />
            <span>{t('navigation.home')}</span>
          </button>
          <button
            className={`${railButtonClassName(false)} task-nav-button`}
            type="button"
            onClick={() => setView('tasks')}
          >
            <Inbox size={19} aria-hidden="true" />
            <span>{t('navigation.inbox')}</span>
            {needsYouCount > 0 && <span className="app-rail-count task-nav-count">{needsYouCount}</span>}
          </button>
          <button
            className={railButtonClassName(view === 'tasks')}
            type="button"
            aria-current={view === 'tasks' ? 'page' : undefined}
            onClick={() => setView('tasks')}
          >
            <ListTodo size={19} aria-hidden="true" />
            <span>{t('navigation.tasks')}</span>
          </button>
          <button
            className={railButtonClassName(false)}
            type="button"
            onClick={() => void chooseWorkingDirectory()}
          >
            <Folder size={19} aria-hidden="true" />
            <span>{t('navigation.files')}</span>
          </button>
          <button
            className={railButtonClassName(view === 'settings')}
            type="button"
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => setView('settings')}
          >
            <LayoutGrid size={19} aria-hidden="true" />
            <span>{t('navigation.apps')}</span>
          </button>
          <button
            className={railButtonClassName(false)}
            type="button"
            onClick={() => setSourceSettingsOpen(true)}
          >
            <Plug size={19} aria-hidden="true" />
            <span>{t('navigation.plugins')}</span>
          </button>
        </nav>

        <div ref={accountAreaRef} className="account-area app-rail-account">
          <button
            ref={accountTriggerRef}
            className="account-row"
            type="button"
            aria-label={t('navigation.account')}
            aria-controls="account-panel"
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            onClick={() => setAccountOpen(!accountOpen)}
          >
            <span className="account-avatar">BA</span>
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
            <button className="account-menu-item" type="button" role="menuitem" onClick={() => { setAccountOpen(false); setView('settings') }}>
              <Settings2 size={14} /><span>{t('sidebar.settings')}</span><ChevronRight className="account-menu-chevron" size={13} />
            </button>
            <button className="account-menu-item" type="button" role="menuitem" onClick={() => { setAccountOpen(false); setSourceSettingsOpen(true) }}>
              <FolderSearch size={14} /><span>{t('sidebar.localSources')}</span><ChevronRight className="account-menu-chevron" size={13} />
            </button>
            <button className="account-menu-item" type="button" role="menuitem" onClick={() => { setAccountOpen(false); setDiagnosticsOpen(true) }}>
              <Stethoscope size={14} /><span>{t('sidebar.diagnostics')}</span><ChevronRight className="account-menu-chevron" size={13} />
            </button>
            <button className="account-menu-item" type="button" role="menuitem" onClick={() => { setAccountOpen(false); setSettingsOpen(true) }}>
              <Wrench size={14} /><span>{t('sidebar.models')}</span><ChevronRight className="account-menu-chevron" size={13} />
            </button>
            <LanguagePicker />
          </div>
        </div>
      </aside>

      <div className={workspaceShellClassName} data-testid="workspace-shell">
        <main className="workspace">
        <div className={workspaceBodyClassName}>
          {view === 'settings' ? (
            <SettingsPage
              onOpenModels={() => setSettingsOpen(true)}
              onOpenSources={() => setSourceSettingsOpen(true)}
              onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            />
          ) : view === 'tasks' ? (
            <>
              <h1 className="visually-hidden">{t('tasks.title')}</h1>
              <TaskCenter
                tasks={tasks}
                loading={tasksLoading}
                error={taskError}
                onOpenTask={openTask}
                onError={setTaskError}
              />
            </>
          ) : view === 'task-detail' ? (
            (() => {
              const selectedTask = tasks.find((task) => task.id === selectedTaskId)
              return selectedTask === undefined ? (
                <div className="task-detail-page task-detail-empty">
                  <strong>{t('tasks.emptyTitle')}</strong>
                  <button type="button" className="task-detail-back" onClick={() => setView('tasks')}>
                    {t('tasks.back')}
                  </button>
                </div>
              ) : (
                <TaskDetailPage task={selectedTask} onBack={() => setView('tasks')} />
              )
            })()
          ) : (
            <>
              {!rightPanelOpen && (
                <div className="today-home-column">
                  <TodayPanel
                    tasks={tasks}
                    onOpenTasks={() => setView('tasks')}
                    onConnectSources={() => setSourceSettingsOpen(true)}
                    onRefresh={() => void refreshTasks()}
                  />
                </div>
              )}
              <div className="conversation-view">
              <section
                ref={listRef}
                className={displayMessages.length === 0 && displayLiveParts.length === 0 && !running ? 'conversation-surface empty-conversation' : 'conversation-surface chat-surface'}
              >
                {displayMessages.length === 0 && displayLiveParts.length === 0 && !running ? (
                  <div className="secretary-empty-state">
                    <span className="secretary-presence" aria-hidden="true">
                      <Sparkles size={21} />
                    </span>
                    <h1>{t('conversation.heroTitle')}</h1>
                    <p>{t('conversation.heroSubtitle')}</p>
                  </div>
                ) : (
                  <MessageBubbleGroup className="message-list" spacing="default">
                    {displayMessages.map((message) => (
                      <MessageBubble
                        aria-label={message.role === 'user' ? t('conversation.userMessage') : t('conversation.barnMessage')}
                        align={message.role === 'user' ? 'end' : 'start'}
                        className={`chat-message thread-message ${message.role}${message.isError ? ' error' : ''}`}
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
                        {message.role === 'user' && message.routerRequestId !== undefined && (() => {
                          const request = routerRequests.find((candidate) => candidate.id === message.routerRequestId)
                          if (request === undefined) return null
                          return (
                            <span className="router-message-state" data-status={request.status}>
                              <span>{routerRequestStatusLabel(request)}</span>
                              {(request.status === 'queued' || request.status === 'routing') && (
                                <button
                                  className="router-request-cancel"
                                  type="button"
                                  aria-label={t('router.cancelRequest')}
                                  onClick={() => void cancelRouterRequest(request.id)}
                                >
                                  <X size={11} aria-hidden="true" />
                                </button>
                              )}
                            </span>
                          )
                        })()}
                        {message.role === 'assistant' && message.resultCard !== undefined && (() => {
                          const task = message.taskId === undefined
                            ? undefined
                            : tasks.find((candidate) => candidate.id === message.taskId)
                          const card = task !== undefined && message.resultCard?.kind === 'task'
                            ? { ...message.resultCard, status: t(`tasks.status.${task.status}`) }
                            : message.resultCard
                          return (
                            <AssistantResult
                              card={card}
                              onOpenLink={(url) => void openResultLink(url)}
                              {...(task === undefined ? {} : { onOpenTask: () => openTask(task) })}
                            />
                          )
                        })()}
                      </MessageBubble>
                    ))}
                    {running && displayLiveParts.length === 0 && (
                      <MessageBubble
                        aria-label={t('conversation.barnMessage')}
                        className="chat-message assistant live-turn"
                        role="article"
                        variant="ghost"
                      >
                        <PendingThinking />
                      </MessageBubble>
                    )}
                    {displayLiveParts.length > 0 && (
                      <MessageBubble
                        aria-label={t('conversation.barnMessage')}
                        className="chat-message assistant streaming live-turn"
                        role="article"
                        variant="ghost"
                      >
                        <ConversationParts
                          parts={displayLiveParts}
                          role="assistant"
                          keyPrefix="live"
                        />
                      </MessageBubble>
                    )}
                  </MessageBubbleGroup>
                )}

                {routerQueuedCount > 0 && (
                  <div className="router-queue-summary" role="status">
                    {t('router.queueSummary', { count: routerQueuedCount })}
                  </div>
                )}

                {error !== undefined && (
                  <div className="error-banner" role="alert">
                    {error}
                  </div>
                )}
              </section>

              <div className="composer-dock">
                <div className={workingDirectory === undefined ? 'composer-project composer-project-empty' : 'composer-project'}>
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
                    className="barn-prompt-input barn-prompt-inline"
                    disabled={modelSelectionBusy}
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
                    maxRows={4}
                    minRows={1}
                    onAction={(action) => {
                      if (action === 'attach') void attachFiles()
                    }}
                    onSubmit={() => void sendPrompt()}
                    onValueChange={setInput}
                    placeholder={t('conversation.placeholder')}
                    sendLabel={t('conversation.sendMessage')}
                    value={input}
                  />
                </div>
              </div>
              </div>
            </>
          )}

          {view === 'conversation' && !rightPanelOpen && (
            <TaskRail tasks={tasks} onOpenTask={openTask} onOpenTasks={() => setView('tasks')} />
          )}

        </div>
      </main>

      {browserApproval !== undefined && !browserOpen && (
        <aside className="background-browser-approval" role="alertdialog" aria-label="Browser action approval">
          <div className="background-browser-approval-copy">
            <strong>Approve browser action?</strong>
            <span>{browserApproval.summary}</span>
          </div>
          <div className="background-browser-approval-actions">
            <button type="button" className="is-deny" onClick={() => void resolveBrowserApproval('denied')}>
              Deny
            </button>
            <button type="button" className="is-approve" aria-label="Approve browser action" onClick={() => void resolveBrowserApproval('approved')}>
              Approve
            </button>
          </div>
        </aside>
      )}

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
          onClose={() => setUtilityOpen(false)}
          onError={(message) => setError(message)}
        />
      )}
      </div>

      <CommandPalette
        open={commandOpen}
        tasks={tasks}
        onClose={() => setCommandOpen(false)}
        onOpenTask={openTask}
        onOpenTasks={() => {
          setCommandOpen(false)
          setView('tasks')
        }}
      />

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

function upsertRouterRequest(current: RouterRequest[], request: RouterRequest): RouterRequest[] {
  return [...current.filter((item) => item.id !== request.id), request]
    .toSorted((left, right) => left.sequence - right.sequence)
}


function upsertTask(current: Task[], task: Task): Task[] {
  return [task, ...current.filter((item) => item.id !== task.id)]
}

function errorMessage(reason: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  return reason instanceof Error ? reason.message : t('conversation.somethingWentWrong')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${Math.round(bytes / (1_024 * 1_024) * 10) / 10} MB`
}

function upsertVisibleMessage(current: VisibleMessage[], message: VisibleMessage): VisibleMessage[] {
  return [...current.filter((item) => item.id !== message.id), message].toSorted((left, right) => left.seq - right.seq)
}
