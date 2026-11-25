import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import 'streamdown/styles.css'
import {
  Clock3,
  ChevronDown,
  ChevronRight,
  Folder,
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
  Trash2,
} from 'lucide-react'
import type {
  ApprovalRequest,
  AttachmentDescriptor,
  BrowserState,
  ModelConfigSnapshot,
  SessionLiveEvent,
  RouterRequest,
  SessionSummary,
  SkillSummary,
  Task,
  TaskLiveEvent,
  VisibleMessage,
} from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'
import { ModelPicker } from './ModelPicker'
import { LanguagePicker } from './LanguagePicker'
import { PluginsPage } from './PluginsPage'
import { SettingsPage, type SettingsSectionKey } from './SettingsPage'
import { AppToaster, useErrorToast } from './notifications'
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
import { TaskApprovalCard } from './TaskApprovalCard'
import { ReplyGuideGroup } from './ReplyGuideGroup'
import { CommandPalette } from './CommandPalette'
import { isExecutingTask, resolveMessageActivity } from './message-activity'
import './secretary.css'
import './home-redesign.css'
import './agent-activity.css'
import './conversation-guide.css'
import { initializeAppLanguage } from './i18n'
import { buildSkillCommands, commandForSkill } from './skill-commands'
import { TooltipButton } from './components/TooltipButton'
import { MessageBubble, MessageBubbleGroup } from '@/components/beui/components/agents/message-bubble'
import { PromptInput } from '@/components/beui/components/agents/prompt-input'
import {
  applyLiveEvent,
  conversationRenderEntries,
  mergeThreadAndSessionMessages,
  type ChatMessage,
  messagesFromEvents,
  type ConversationPart,
} from './conversation'

function railButtonClassName(active: boolean): string {
  return active ? 'app-rail-button active' : 'app-rail-button'
}

type HomePane = 'routines' | 'tasks'

const DEFAULT_HOME_PANE_WIDTHS: Record<HomePane, number> = {
  routines: 320,
  tasks: 304,
}

const HOME_PANE_LIMITS: Record<HomePane, { min: number; max: number }> = {
  routines: { min: 248, max: 430 },
  tasks: { min: 272, max: 420 },
}

const ACKNOWLEDGED_ROUTINES_STORAGE_KEY = 'barn.acknowledged-routines'

function readAcknowledgedRoutineIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(ACKNOWLEDGED_ROUTINES_STORAGE_KEY)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string').slice(-200) : [])
  } catch {
    return new Set()
  }
}

function persistAcknowledgedRoutineIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(ACKNOWLEDGED_ROUTINES_STORAGE_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    // Acknowledgement remains effective for the current app session.
  }
}

function clampPaneWidth(side: HomePane, width: number): number {
  const limit = HOME_PANE_LIMITS[side]
  return Math.round(Math.min(limit.max, Math.max(limit.min, width)))
}

export function App() {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot>()
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>()
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [threadMessages, setThreadMessages] = useState<VisibleMessage[]>([])
  const [routerRequests, setRouterRequests] = useState<RouterRequest[]>([])
  const [input, setInput] = useState('')
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([])
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [workingDirectory, setWorkingDirectory] = useState<string>()
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [accountOpen, setAccountOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [view, setView] = useState<'conversation' | 'tasks' | 'task-detail' | 'plugins' | 'settings'>('conversation')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [tasks, setTasks] = useState<Task[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [taskError, setTaskError] = useState<string>()
  const [acknowledgedRoutineIds, setAcknowledgedRoutineIds] = useState(readAcknowledgedRoutineIds)
  const [conversationFades, setConversationFades] = useState({ top: false, bottom: false })
  const [homePaneWidths, setHomePaneWidths] = useState(DEFAULT_HOME_PANE_WIDTHS)
  const [resizingHomePane, setResizingHomePane] = useState<HomePane>()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [utilityOpen, setUtilityOpen] = useState(false)
  const [utilityTabs, setUtilityTabs] = useState<UtilityTab[]>([])
  const [activeUtilityTabId, setActiveUtilityTabId] = useState<string>()
  useErrorToast(error)
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
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [busyApprovalId, setBusyApprovalId] = useState<string>()
  const listRef = useRef<HTMLElement>(null)
  const composerDockRef = useRef<HTMLDivElement>(null)
  const accountAreaRef = useRef<HTMLDivElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)
  const homePaneResizeRef = useRef<{ side: HomePane; startX: number; startWidth: number; pointerId: number } | undefined>(undefined)
  const promptCommands = useMemo(() => buildSkillCommands(availableSkills), [availableSkills])

  const syncConversationFades = useCallback((): void => {
    const surface = listRef.current
    if (surface === null) return
    const next = {
      top: surface.scrollTop > 2,
      bottom: surface.scrollHeight - surface.scrollTop - surface.clientHeight > 2,
    }
    setConversationFades((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }, [])

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
        if (event.request.status === 'completed' || event.request.status === 'failed') {
          void refreshThreadSnapshot()
        }
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
    const reloadSkills = (): void => {
      void window.barn.skills.list().then(setAvailableSkills).catch(() => undefined)
    }
    reloadSkills()
    const unsubscribeSkills = window.barn.skills.onEvent(reloadSkills)
    return () => {
      unsubscribeTheme()
      unsubscribeTasks()
      unsubscribeThread()
      unsubscribeRouter()
      unsubscribeSkills()
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

  useLayoutEffect(() => {
    const dock = composerDockRef.current
    const surface = listRef.current
    if (dock === null || surface === null) return
    let frame: number | undefined
    const syncComposerSpace = (): void => {
      const distanceFromBottom = surface.scrollHeight - surface.scrollTop - surface.clientHeight
      const keepAtBottom = distanceFromBottom <= 96
      const dockHeight = Math.ceil(dock.getBoundingClientRect().height)
      const safeBottom = Math.max(64, dockHeight - 38)
      surface.style.setProperty('--composer-safe-bottom', `${safeBottom}px`)
      surface.parentElement?.style.setProperty('--composer-safe-bottom', `${safeBottom}px`)
      if (!keepAtBottom) {
        syncConversationFades()
        return
      }
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        surface.scrollTop = surface.scrollHeight
        syncConversationFades()
      })
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncComposerSpace)
    observer?.observe(dock)
    const initialFrame = requestAnimationFrame(syncComposerSpace)
    return () => {
      cancelAnimationFrame(initialFrame)
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [browserOpen, syncConversationFades, utilityOpen, view])

  useEffect(() => {
    const surface = listRef.current
    if (surface === null) return
    syncConversationFades()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncConversationFades)
    observer?.observe(surface)
    const content = surface.querySelector('.message-list')
    if (content !== null) observer?.observe(content)
    return () => observer?.disconnect()
  }, [browserOpen, liveParts, messages, syncConversationFades, threadMessages, utilityOpen, view])

  useEffect(() => {
    const timers = new WeakMap<HTMLElement, number>()
    const onScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      target.classList.add('is-scrolling')
      const previous = timers.get(target)
      if (previous !== undefined) window.clearTimeout(previous)
      timers.set(target, window.setTimeout(() => {
        target.classList.remove('is-scrolling')
        timers.delete(target)
      }, 700))
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [])

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
      setApprovals((current) => {
        const rest = current.filter((entry) => entry.id !== approval.id)
        return [approval, ...rest]
      })
    }
    const unsubscribe = window.barn.approvals.onChange(upsert)
    void window.barn.approvals.listPending().then(setApprovals)
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

  useLayoutEffect(() => {
    const element = listRef.current
    if (element === null) return
    let secondFrame: number | undefined
    const firstFrame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
      secondFrame = requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
        syncConversationFades()
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
    }
  }, [activeSessionId, browserOpen, messages, liveParts, syncConversationFades, threadMessages, utilityOpen, view])

  useLayoutEffect(() => {
    const container = listRef.current
    if (container === null) return
    let frame: number | undefined
    const alignGuideLines = (): void => {
      const userMessages = new Map(
        [...container.querySelectorAll<HTMLElement>('.chat-message.user[data-message-key]')]
          .map((message) => [message.dataset.messageKey, message]),
      )
      for (const run of container.querySelectorAll<HTMLElement>('.assistant-reply-run[data-source-message-key]')) {
        const key = run.dataset.sourceMessageKey
        const user = key === undefined ? undefined : userMessages.get(key)
        if (user === undefined) continue
        const runRect = run.getBoundingClientRect()
        const userRect = user.getBoundingClientRect()
        const guideTop = userRect.top + userRect.height / 2 - runRect.top
        run.style.setProperty('--reply-guide-top', `${Math.round(guideTop)}px`)
      }
    }
    const schedule = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(alignGuideLines)
    }
    schedule()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const messageList = container.querySelector('.message-list')
    if (messageList !== null) observer?.observe(messageList)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [browserOpen, liveParts, messages, threadMessages, utilityOpen, view])

  async function refreshThreadSnapshot(): Promise<void> {
    try {
      const threadSnapshot = await window.barn.threads.getSnapshot()
      setThreadMessages((current) => mergeVisibleMessageSnapshots(current, threadSnapshot.messages))
    } catch {
      // Router terminal events already have a durable message; a transient refresh
      // failure must not erase the current visible conversation.
    }
  }

  async function loadSession(sessionId: string): Promise<void> {
    try {
      const events = await window.barn.sessions.getEvents(sessionId)
      setMessages(messagesFromEvents(events))
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  function handleTaskEvent(event: TaskLiveEvent): void {
    if (event.type === 'task.updated') setTasks((current) => upsertTask(current, event.task))
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
      const result = await window.barn.router.submit({
        text,
        clientMessageId,
        ...(filesToSend.length === 0 ? {} : { attachments: filesToSend }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        locale: document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en',
      })
      setRouterRequests((current) => upsertRouterRequest(current, result.request))
    } catch (reason) {
      setInput(text)
      setAttachments(filesToSend)
      setError(errorMessage(reason, t))
    }
  }

  function trySkill(skill: SkillSummary): void {
    const command = commandForSkill(skill, promptCommands)
      ?? buildSkillCommands([skill])[0]
    setInput(command === undefined ? `${skill.name} ` : `${command.value} `)
    setView('conversation')
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

  function acknowledgeRoutine(routineId: string): void {
    setAcknowledgedRoutineIds((current) => {
      if (current.has(routineId)) return current
      const next = new Set(current)
      next.add(routineId)
      persistAcknowledgedRoutineIds(next)
      return next
    })
  }

  function openRoutine(routineId: string): void {
    const surface = listRef.current
    if (surface === null) return
    const message = [...surface.querySelectorAll<HTMLElement>('.chat-message[data-message-key]')]
      .find((candidate) => candidate.dataset.messageKey === routineId)
    message?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
    const approval = approvals.find((entry) => entry.status === 'pending' && entry.title === 'Approve browser action')
    if (approval === undefined) return
    try {
      const resolved = await window.barn.approvals.resolve(approval.id, decision)
      setApprovals((current) => [resolved, ...current.filter((entry) => entry.id !== resolved.id)])
    } catch (reason) {
      setError(errorMessage(reason, t))
    }
  }

  async function resolveTaskApproval(approval: ApprovalRequest, decision: 'approved' | 'denied'): Promise<void> {
    setBusyApprovalId(approval.id)
    setError(undefined)
    try {
      const resolved = await window.barn.approvals.resolve(approval.id, decision)
      setApprovals((current) => [resolved, ...current.filter((entry) => entry.id !== resolved.id)])
    } catch (reason) {
      setError(errorMessage(reason, t))
    } finally {
      setBusyApprovalId(undefined)
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
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending')
  const browserApproval = pendingApprovals.find((approval) => approval.title === 'Approve browser action')
  const routines = displayMessages
    .filter((message) => message.routineDelivery === true && !acknowledgedRoutineIds.has(message.key))
    .slice(-20)
    .toReversed()
    .map((message) => {
      const text = message.parts
        .flatMap((part) => part.type === 'text' ? [part.text] : [])
        .join(' ')
        .trim()
      return {
        id: message.key,
        title: message.routineTitle ?? text,
        ...(message.routinePrompt === undefined ? {} : { body: message.routinePrompt }),
        ...(message.routineRecurrence === undefined ? {} : { recurrence: message.routineRecurrence }),
        ...(message.createdAt === undefined ? {} : { deliveredAt: message.createdAt }),
      }
    })
  const workTasks = tasks.filter((task) => task.kind !== 'reminder')
  const needsYouCount = workTasks.filter((task) => ['proposed', 'waiting', 'failed'].includes(task.status)).length
  const messageActivity = resolveMessageActivity(routerRequests, tasks, pending)
  const activityDetail = messageActivity?.kind === 'task'
    ? t(
        messageActivity.activeTaskCount > 1
          ? messageActivity.task.status === 'queued'
            ? 'conversation.taskProgressQueuedMore'
            : 'conversation.taskProgressRunningMore'
          : messageActivity.task.status === 'queued'
            ? 'conversation.taskProgressQueued'
            : 'conversation.taskProgressRunning',
        { title: messageActivity.task.title, count: messageActivity.activeTaskCount },
      )
    : undefined
  const hasStreamingAssistantText = displayLiveParts.some((part) => part.type === 'text' && part.text.trim().length > 0)
  const showMessageActivity = messageActivity !== undefined && !hasStreamingAssistantText
  const conversationIdle = displayMessages.length === 0
    && displayLiveParts.length === 0
    && !running
    && messageActivity === undefined
  const completedDisplayMessages = displayMessages.filter((message) => {
    if (
      message.role === 'assistant'
      && message.resultCard?.kind === 'task'
      && (message.resultCard.meta === '由 Router 委派' || message.resultCard.meta === 'Router delegated this request')
    ) {
      return false
    }
    if (message.role !== 'assistant' || message.taskId === undefined || message.resultCard?.kind !== 'task') return true
    const task = tasks.find((candidate) => candidate.id === message.taskId)
    return task === undefined || !isExecutingTask(task)
  })
  const renderEntries = conversationRenderEntries(completedDisplayMessages)
  const taskResultTaskIds = new Set(completedDisplayMessages.flatMap((message) => (
    message.taskResult === true && message.taskId !== undefined ? [message.taskId] : []
  )))
  const standaloneApprovals = pendingApprovals.filter((approval) => (
    approval.taskId !== undefined && !taskResultTaskIds.has(approval.taskId)
  ))
  const activityState = messageActivity?.kind === 'task' ? 'working' : 'composing'
  const activityLabel = messageActivity?.kind === 'task'
    ? messageActivity.task.status === 'queued'
      ? t('conversation.taskQueued')
      : t('conversation.taskWorking')
    : t('conversation.thinkingNow')

  function renderUserMessage(message: ChatMessage) {
    return (
      <MessageBubble
        aria-label={t('conversation.userMessage')}
        align="end"
        className={`chat-message thread-message ${message.role}${message.isError ? ' error' : ''}`}
        data-message-key={message.key}
        key={message.key}
        role="article"
        variant="ghost"
      >
        <ConversationParts
          parts={message.parts}
          role={message.role}
          keyPrefix={message.key}
        />
        {message.attachments.length > 0 && (
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
    )
  }

  function renderAssistantMessage(message: ChatMessage) {
    return (
      <MessageBubble
        aria-label={t('conversation.barnMessage')}
        align="start"
        className={`chat-message thread-message ${message.role}${message.isError ? ' error' : ''}`}
        data-message-key={message.key}
        role="article"
        variant="ghost"
      >
        <ConversationParts
          parts={message.parts}
          role={message.role}
          keyPrefix={message.key}
        />
        {message.resultCard !== undefined && (() => {
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
    )
  }

  function replyQuotePreview(message: ChatMessage): string {
    const text = message.parts
      .flatMap((part) => part.type === 'text' ? [part.text] : [])
      .join(' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
    if (text.length > 0) return text.length > 72 ? `${text.slice(0, 71)}…` : text
    const attachment = message.attachments[0]
    return attachment === undefined ? t('conversation.userMessage') : attachmentDisplayName(attachment)
  }

  function openTask(task: Task): void {
    setCommandOpen(false)
    setSelectedTaskId(task.id)
    setView('task-detail')
  }

  function draftSessionId(): string {
    draftSessionIdRef.current ??= crypto.randomUUID()
    return draftSessionIdRef.current
  }

  function beginHomePaneResize(side: HomePane, event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    homePaneResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: homePaneWidths[side],
      pointerId: event.pointerId,
    }
    setResizingHomePane(side)
  }

  function moveHomePaneResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = homePaneResizeRef.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    const physicalDelta = event.clientX - active.startX
    const widthDelta = active.side === 'routines' ? physicalDelta : -physicalDelta
    const nextWidth = clampPaneWidth(active.side, active.startWidth + widthDelta)
    setHomePaneWidths((current) => current[active.side] === nextWidth ? current : { ...current, [active.side]: nextWidth })
  }

  function finishHomePaneResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = homePaneResizeRef.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    homePaneResizeRef.current = undefined
    setResizingHomePane(undefined)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function nudgeHomePane(side: HomePane, event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const physicalDelta = event.key === 'ArrowRight' ? 16 : -16
    const widthDelta = side === 'routines' ? physicalDelta : -physicalDelta
    setHomePaneWidths((current) => ({
      ...current,
      [side]: clampPaneWidth(side, current[side] + widthDelta),
    }))
  }

  function resetHomePane(side: HomePane): void {
    setHomePaneWidths((current) => ({ ...current, [side]: DEFAULT_HOME_PANE_WIDTHS[side] }))
  }

  const appShellClassName = [
    'app-shell',
    'secretary-shell',
    'js',
    window.barn.platform === 'darwin' ? 'platform-darwin' : '',
  ].filter(Boolean).join(' ')
  const workspaceShellClassName = rightPanelOpen ? 'workspace-shell browser-open' : 'workspace-shell'
  const workspaceBodyClassName = [
    'workspace-body',
    view === 'conversation' && !rightPanelOpen ? 'secretary-home' : '',
  ].filter(Boolean).join(' ')
  const homeLayoutStyle = view === 'conversation' && !rightPanelOpen
    ? ({
        '--home-routines-width': `${homePaneWidths.routines}px`,
        '--home-tasks-width': `${homePaneWidths.tasks}px`,
      } as CSSProperties)
    : undefined

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
            className={railButtonClassName(view === 'tasks' || view === 'task-detail')}
            type="button"
            aria-current={view === 'tasks' || view === 'task-detail' ? 'page' : undefined}
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
            className={railButtonClassName(view === 'plugins')}
            type="button"
            aria-current={view === 'plugins' ? 'page' : undefined}
            onClick={() => setView('plugins')}
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
            <button className="account-menu-item" type="button" role="menuitem" onClick={() => { setAccountOpen(false); setSettingsSection(undefined); setView('settings') }}>
              <Settings2 size={14} /><span>{t('sidebar.settings')}</span><ChevronRight className="account-menu-chevron" size={13} />
            </button>
            <LanguagePicker />
          </div>
        </div>
      </aside>

      <div className={workspaceShellClassName} data-testid="workspace-shell">
        <main className="workspace">
        <div className={workspaceBodyClassName} style={homeLayoutStyle}>
          {view === 'plugins' ? (
            <PluginsPage onTrySkill={trySkill} />
          ) : view === 'settings' ? (
            <SettingsPage
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              {...(settingsSection === undefined ? {} : { initialSection: settingsSection })}
            />
          ) : view === 'tasks' ? (
            <TaskCenter
              tasks={workTasks}
              approvals={pendingApprovals.filter((approval) => approval.title !== 'Approve browser action')}
              loading={tasksLoading}
              error={taskError}
              onOpenTask={openTask}
              onRefresh={() => void refreshTasks()}
              onError={setTaskError}
            />
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
                <TaskDetailPage
                  task={selectedTask}
                  onBack={() => setView('tasks')}
                />
              )
            })()
          ) : (
            <>
              {!rightPanelOpen && (
                <div className="today-home-column">
                  <TodayPanel
                    routines={routines}
                    onAcknowledgeRoutine={acknowledgeRoutine}
                    onConnectSources={() => setView('plugins')}
                    onOpenRoutine={openRoutine}
                    onRefresh={() => void refreshTasks()}
                  />
                </div>
              )}
              <div className="conversation-view">
              <section
                ref={listRef}
                onScroll={syncConversationFades}
                className={conversationIdle ? 'conversation-surface empty-conversation' : 'conversation-surface chat-surface'}
              >
                {conversationIdle ? (
                  <div className="secretary-empty-state">
                    <span className="secretary-presence" aria-hidden="true">
                      <Sparkles size={21} />
                    </span>
                    <h1>{t('conversation.heroTitle')}</h1>
                    <p>{t('conversation.heroSubtitle')}</p>
                  </div>
                ) : (
                  <MessageBubbleGroup className="message-list" spacing="default">
                    {renderEntries.map((entry) => {
                      if (entry.kind === 'task-result') {
                        const message = entry.message
                        const task = message.taskId === undefined
                          ? undefined
                          : tasks.find((candidate) => candidate.id === message.taskId)
                        const taskApprovals = message.taskId === undefined
                          ? []
                          : approvals.filter((approval) => approval.taskId === message.taskId)
                        return (
                          <article className="task-result-notice" data-message-key={message.key} key={message.key}>
                            <span className="task-result-label">
                              {task?.status === 'waiting' && task.waitingReason === 'approval'
                                ? t('approvals.taskLabel', { title: task.title })
                                : t('tasks.taskResultFor', { title: task?.title ?? t('tasks.title') })}
                            </span>
                            <MessageBubble
                              aria-label={t('conversation.barnMessage')}
                              align="start"
                              className="chat-message assistant task-result-message"
                              role="article"
                              variant="ghost"
                            >
                              <ConversationParts parts={message.parts} role="assistant" keyPrefix={message.key} />
                            </MessageBubble>
                            {taskApprovals.length > 0 && (
                              <div className="task-approval-stack">
                                {taskApprovals.map((approval) => (
                                  <TaskApprovalCard
                                    approval={approval}
                                    busy={busyApprovalId === approval.id}
                                    key={approval.id}
                                    onResolve={(decision) => void resolveTaskApproval(approval, decision)}
                                  />
                                ))}
                              </div>
                            )}
                          </article>
                        )
                      }
                      const group = entry.group
                      if (group.kind === 'user') return renderUserMessage(group.message)
                      if (group.kind === 'proactive') {
                        return (
                          <div className="proactive-message" key={group.key}>
                            {renderAssistantMessage(group.message)}
                          </div>
                        )
                      }
                      return (
                        <ReplyGuideGroup
                          className="assistant-reply-group"
                          data-source-message-key={group.replies[0]?.sourceUser?.key}
                          guide="anchored"
                          key={group.key}
                        >
                          {group.replies.map((reply) => (
                            <div className="assistant-reply-segment" key={reply.message.key}>
                              {reply.quotedUser !== undefined && (
                                <span
                                  className="assistant-reply-quote"
                                  data-quoted-message-key={reply.quotedUser.key}
                                  title={replyQuotePreview(reply.quotedUser)}
                                >
                                  {replyQuotePreview(reply.quotedUser)}
                                </span>
                              )}
                              {renderAssistantMessage(reply.message)}
                            </div>
                          ))}
                        </ReplyGuideGroup>
                      )
                    })}
                    {standaloneApprovals.map((approval) => {
                      const task = approval.taskId === undefined
                        ? undefined
                        : tasks.find((candidate) => candidate.id === approval.taskId)
                      return (
                        <article className="task-result-notice" data-approval-id={approval.id} key={`approval:${approval.id}`}>
                          <span className="task-result-label">
                            {t('approvals.taskLabel', { title: task?.title ?? t('tasks.title') })}
                          </span>
                          <TaskApprovalCard
                            approval={approval}
                            busy={busyApprovalId === approval.id}
                            onResolve={(decision) => void resolveTaskApproval(approval, decision)}
                          />
                        </article>
                      )
                    })}
                    {(showMessageActivity || displayLiveParts.length > 0) && (
                      <div className="assistant-live-turn" key={messageActivity?.id ?? 'assistant-live'}>
                        {messageActivity !== undefined && showMessageActivity && (
                          <div
                            aria-label={t('conversation.barnMessage')}
                            className="assistant-live-activity"
                            role="article"
                          >
                            <PendingThinking
                              state={activityState}
                              label={activityLabel}
                              {...(activityDetail === undefined ? {} : { detail: activityDetail })}
                            />
                          </div>
                        )}
                        {displayLiveParts.length > 0 && (
                          <ReplyGuideGroup guide="anchored">
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
                          </ReplyGuideGroup>
                        )}
                      </div>
                    )}

                  </MessageBubbleGroup>
                )}
              </section>

              <span
                className="conversation-fade conversation-fade-top"
                data-visible={conversationFades.top}
                aria-hidden="true"
              />
              <span
                className="conversation-fade conversation-fade-bottom"
                data-visible={conversationFades.bottom}
                aria-hidden="true"
              />

              <div ref={composerDockRef} className="composer-dock">
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
                    commandEmpty={t('conversation.skillCommandEmpty')}
                    commandHint={t('conversation.skillCommandHint', { count: promptCommands.length })}
                    commandMenuLabel={t('conversation.skillCommands')}
                    commands={promptCommands}
                    disabled={modelSelectionBusy}
                    leadingAction={(
                      <ModelPicker
                        snapshot={snapshot}
                        onSnapshot={setSnapshot}
                        onConfigure={() => { setSettingsSection('models'); setView('settings') }}
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
            <>
              <TaskRail tasks={workTasks} onOpenTask={openTask} onOpenTasks={() => setView('tasks')} />
              <div
                className="home-pane-divider home-pane-divider-routines"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('secretary.resizeRoutines')}
                aria-valuemin={HOME_PANE_LIMITS.routines.min}
                aria-valuemax={HOME_PANE_LIMITS.routines.max}
                aria-valuenow={homePaneWidths.routines}
                data-resizing={resizingHomePane === 'routines'}
                tabIndex={0}
                title={t('secretary.resizePane')}
                onPointerDown={(event) => beginHomePaneResize('routines', event)}
                onPointerMove={moveHomePaneResize}
                onPointerUp={finishHomePaneResize}
                onPointerCancel={finishHomePaneResize}
                onDoubleClick={() => resetHomePane('routines')}
                onKeyDown={(event) => nudgeHomePane('routines', event)}
              >
                <span className="home-pane-divider-line" aria-hidden="true" />
                <span className="home-pane-divider-grip" aria-hidden="true" />
                <span className="home-pane-divider-tooltip" aria-hidden="true">{t('secretary.resizePane')}</span>
              </div>
              <div
                className="home-pane-divider home-pane-divider-tasks"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('secretary.resizeTasks')}
                aria-valuemin={HOME_PANE_LIMITS.tasks.min}
                aria-valuemax={HOME_PANE_LIMITS.tasks.max}
                aria-valuenow={homePaneWidths.tasks}
                data-resizing={resizingHomePane === 'tasks'}
                tabIndex={0}
                title={t('secretary.resizePane')}
                onPointerDown={(event) => beginHomePaneResize('tasks', event)}
                onPointerMove={moveHomePaneResize}
                onPointerUp={finishHomePaneResize}
                onPointerCancel={finishHomePaneResize}
                onDoubleClick={() => resetHomePane('tasks')}
                onKeyDown={(event) => nudgeHomePane('tasks', event)}
              >
                <span className="home-pane-divider-line" aria-hidden="true" />
                <span className="home-pane-divider-grip" aria-hidden="true" />
                <span className="home-pane-divider-tooltip" aria-hidden="true">{t('secretary.resizePane')}</span>
              </div>
            </>
          )}

        </div>
      </main>

      {browserApproval !== undefined && !browserOpen && (view !== 'conversation' || browserApproval.taskId === undefined) && (
        <aside className="background-browser-approval" role="alertdialog" aria-label="Browser action approval">
          <TaskApprovalCard
            approval={browserApproval}
            busy={busyApprovalId === browserApproval.id}
            onResolve={(decision) => void resolveBrowserApproval(decision)}
          />
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
        tasks={workTasks}
        onClose={() => setCommandOpen(false)}
        onOpenTask={openTask}
        onOpenTasks={() => {
          setCommandOpen(false)
          setView('tasks')
        }}
      />

      <AppToaster />
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
  const translate = t as (key: string) => string
  return reason instanceof Error ? reason.message : translate('conversation.somethingWentWrong')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${Math.round(bytes / (1_024 * 1_024) * 10) / 10} MB`
}

function mergeVisibleMessageSnapshots(current: VisibleMessage[], incoming: VisibleMessage[]): VisibleMessage[] {
  const merged = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) merged.set(message.id, message)
  return [...merged.values()].toSorted((left, right) => left.seq - right.seq)
}

function upsertVisibleMessage(current: VisibleMessage[], message: VisibleMessage): VisibleMessage[] {
  return [...current.filter((item) => item.id !== message.id), message].toSorted((left, right) => left.seq - right.seq)
}
