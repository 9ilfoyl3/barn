import { useEffect, useRef, useState } from 'react'
import { Streamdown, type Components } from 'streamdown'
import 'streamdown/styles.css'
import {
  Bell,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleX,
  ClipboardList,
  Command,
  FolderKanban,
  LogIn,
  LogOut,
  CornerDownLeft,
  LoaderCircle,
  PanelLeft,
  Paperclip,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import type {
  AttachmentDescriptor,
  AuthState,
  EmployeeIntake,
  EmployeeIntakeCommitResult,
  EmployeeDetail,
  EmployeeIntakePreview,
  EmployeeSearchInput,
  EmployeeSearchResult,
  LifecycleCaseSearchInput,
  LifecycleCaseSearchResult,
  LifecycleCaseStatus,
  LifecycleProposal,
  LifecycleTaskUpdateInput,
  HrNotification,
  ModelConfigSnapshot,
  RuntimeCapabilities,
  SessionLiveEvent,
  SessionSummary,
} from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'
import { ModelSettings } from './ModelSettings'
import { EmployeeIntakePanel } from './EmployeeIntakePanel'
import { WorkspaceDrawer } from './WorkspaceDrawer'
import { LifecycleProposalDialog } from './LifecycleProposalDialog'
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
  const [snapshot, setSnapshot] = useState<ModelConfigSnapshot>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([])
  const [liveParts, setLiveParts] = useState<ConversationPart[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [intake, setIntake] = useState<EmployeeIntake>()
  const [intakePanelOpen, setIntakePanelOpen] = useState(false)
  const [intakePreview, setIntakePreview] = useState<EmployeeIntakePreview>()
  const [intakeCommitResult, setIntakeCommitResult] = useState<EmployeeIntakeCommitResult>()
  const [intakeBusy, setIntakeBusy] = useState(false)
  const [intakeError, setIntakeError] = useState<string>()
  const [workspaceMode, setWorkspaceMode] = useState<'workspace' | 'employees' | 'lifecycle'>()
  const [employeeResult, setEmployeeResult] = useState<EmployeeSearchResult>()
  const [employeeQuery, setEmployeeQuery] = useState<EmployeeSearchInput>({ page: 1, pageSize: 25 })
  const [employeeDetail, setEmployeeDetail] = useState<EmployeeDetail>()
  const [employeeDetailLoading, setEmployeeDetailLoading] = useState(false)
  const [lifecycleResult, setLifecycleResult] = useState<LifecycleCaseSearchResult>()
  const [lifecycleStatus, setLifecycleStatus] = useState<'' | LifecycleCaseStatus>('')
  const [lifecycleLoading, setLifecycleLoading] = useState(false)
  const [lifecycleProposal, setLifecycleProposal] = useState<LifecycleProposal>()
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleError, setLifecycleError] = useState<string>()
  const [lifecycleNotice, setLifecycleNotice] = useState<string>()
  const lifecycleDecisionKeyRef = useRef<string | undefined>(undefined)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [contextStatus, setContextStatus] = useState<{ tokens: number; budget: number; compacted: boolean }>()
  const [authState, setAuthState] = useState<AuthState>({ status: 'loading' })
  const [authBusy, setAuthBusy] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [notifications, setNotifications] = useState<HrNotification[]>([])
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [notificationLoading, setNotificationLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)
  const lifecycleProposalIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    void window.barn.auth.getState().then(setAuthState).catch(() => setAuthState({ status: 'unauthenticated' }))
    const unsubscribeAuth = window.barn.auth.onStateChanged(setAuthState)
    void window.barn.models.getSnapshot()
      .then(setSnapshot)
      .catch((reason: unknown) => setError(errorMessage(reason)))
    void window.barn.sessions.list()
      .then((value) => {
        setSessions(value)
        const initialSessionId = value[0]?.id
        activeSessionIdRef.current = initialSessionId
        setActiveSessionId(initialSessionId)
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
    void window.barn.getCapabilities()
      .then(setCapabilities)
      .catch((reason: unknown) => setError(errorMessage(reason)))
    return unsubscribeAuth
  }, [])

  useEffect(() => {
    if (authState.status === 'authenticated') {
      void loadNotifications()
    } else if (authState.status === 'unauthenticated') {
      setNotifications([])
      setNotificationOpen(false)
    }
  }, [authState.status])

  useEffect(() => {
    if (!notificationOpen || authState.status !== 'authenticated') return
    const timer = window.setInterval(() => void loadNotifications(), 2_000)
    return () => window.clearInterval(timer)
  }, [notificationOpen, authState.status])

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
    setMessages([])
    setLiveParts([])
    setAttachments([])
    setIntake(undefined)
    setIntakePanelOpen(false)
    setIntakePreview(undefined)
    setIntakeCommitResult(undefined)
    setIntakeError(undefined)
    setContextStatus(undefined)
    if (activeSessionId === undefined) return
    void loadSession(activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    return window.barn.sessions.onEvent(handleLiveEvent)
  }, [])

  useEffect(() => {
    const element = listRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [messages, liveParts])

  async function loadSession(sessionId: string): Promise<void> {
    try {
      const [events, currentIntake] = await Promise.all([
        window.barn.sessions.getEvents(sessionId),
        window.barn.sessions.getIntake(sessionId),
      ])
      setMessages(messagesFromEvents(events))
      setIntake(currentIntake)
      setIntakePanelOpen(currentIntake !== undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  function handleLiveEvent(event: SessionLiveEvent): void {
    const sessionId = activeSessionIdRef.current
    if (event.type === 'session.updated') {
      setSessions((current) => upsertSession(current, event.session))
      if (event.session.id === sessionId) void loadSession(sessionId)
      return
    }
    if (event.type === 'intake.updated') {
      if (event.sessionId === sessionId) {
        setIntake(event.intake)
        setIntakePanelOpen(true)
        setIntakeError(undefined)
        if (event.intake.status !== 'committed') {
          setIntakePreview(undefined)
          setIntakeCommitResult(undefined)
        }
      }
      return
    }
    if (event.type === 'lifecycle.proposal') {
      if (event.sessionId === sessionId) {
        if (lifecycleProposalIdRef.current !== event.proposal.id) {
          lifecycleProposalIdRef.current = event.proposal.id
          lifecycleDecisionKeyRef.current = crypto.randomUUID()
        }
        setLifecycleProposal(event.proposal)
        setLifecycleError(undefined)
      }
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
        if (event.status === 'failed') setError(event.error ?? 'The agent run failed')
      }
    }
  }

  function startNewSession(): void {
    draftSessionIdRef.current = crypto.randomUUID()
    activeSessionIdRef.current = undefined
    setActiveSessionId(undefined)
    setMessages([])
    setLiveParts([])
    setInput('')
    setAttachments([])
    setIntake(undefined)
    setIntakePanelOpen(false)
    setIntakePreview(undefined)
    setIntakeCommitResult(undefined)
    setIntakeError(undefined)
    setContextStatus(undefined)
    setPending(false)
    setError(undefined)
  }

  async function sendPrompt(): Promise<void> {
    const text = input.trim()
    if (text.length === 0 || pending) return
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
      })
      draftSessionIdRef.current = undefined
      setSessions((current) => upsertSession(current, session))
    } catch (reason) {
      if (isNewSession) activeSessionIdRef.current = undefined
      setPending(false)
      setError(errorMessage(reason))
    }
  }

  async function login(): Promise<void> {
    setAuthBusy(true)
    setError(undefined)
    try {
      const state = await window.barn.auth.login()
      setAuthState(state)
      setAccountOpen(false)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAuthBusy(false)
    }
  }

  async function logout(): Promise<void> {
    setAuthBusy(true)
    try {
      setAuthState(await window.barn.auth.logout())
      setAccountOpen(false)
      setWorkspaceMode(undefined)
      setEmployeeResult(undefined)
      setEmployeeDetail(undefined)
      setLifecycleResult(undefined)
      setLifecycleStatus('')
      setLifecycleProposal(undefined)
      setLifecycleError(undefined)
      setLifecycleNotice(undefined)
      lifecycleDecisionKeyRef.current = undefined
      lifecycleProposalIdRef.current = undefined
      setNotifications([])
      setNotificationOpen(false)
      setEmployeeQuery({ page: 1, pageSize: 25 })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAuthBusy(false)
    }
  }

  function requireCloudLogin(): boolean {
    if (authState.status === 'authenticated') return true
    setAccountOpen(true)
    setError('Sign in to Barn Cloud to access employee data.')
    return false
  }

  async function loadEmployees(searchInput: EmployeeSearchInput = employeeQuery): Promise<void> {
    setWorkspaceLoading(true)
    setWorkspaceError(undefined)
    try {
      const normalized = { ...searchInput, page: searchInput.page ?? 1, pageSize: searchInput.pageSize ?? 25 }
      const result = await window.barn.hr.searchEmployees(normalized)
      setEmployeeQuery(normalized)
      setEmployeeResult(result)
    } catch (reason) {
      setWorkspaceError(errorMessage(reason))
    } finally {
      setWorkspaceLoading(false)
    }
  }

  async function openEmployee(employeeId: string): Promise<void> {
    setEmployeeDetailLoading(true)
    try {
      setEmployeeDetail(await window.barn.hr.getEmployee(employeeId))
    } catch (reason) {
      setWorkspaceError(errorMessage(reason))
    } finally {
      setEmployeeDetailLoading(false)
    }
  }

  async function loadLifecycleCases(caseInput: LifecycleCaseSearchInput = {
    status: lifecycleStatus === '' ? undefined : lifecycleStatus,
    page: 1,
    pageSize: 25,
  }): Promise<void> {
    setLifecycleLoading(true)
    setWorkspaceError(undefined)
    try {
      const result = await window.barn.hr.listLifecycleCases(caseInput)
      setLifecycleResult(result)
      setLifecycleStatus(result.cases.length === 0 && caseInput.status === undefined ? '' : (caseInput.status ?? ''))
    } catch (reason) {
      setWorkspaceError(errorMessage(reason))
    } finally {
      setLifecycleLoading(false)
    }
  }

  function openWorkspace(mode: 'workspace' | 'employees' | 'lifecycle'): void {
    setWorkspaceMode(mode)
    setIntakePanelOpen(false)
    if (mode !== 'workspace' && !requireCloudLogin()) return
    if (mode === 'employees') {
      setEmployeeDetail(undefined)
      void loadEmployees({ page: 1, pageSize: employeeQuery.pageSize ?? 25 })
      return
    }
    if (mode === 'lifecycle') {
      setEmployeeDetail(undefined)
      void loadLifecycleCases({ status: lifecycleStatus === '' ? undefined : lifecycleStatus, page: 1, pageSize: 25 })
      return
    }
    setEmployeeDetail(undefined)
  }

  async function updateIntakeEmployee(employeeId: string, fields: Record<string, string>): Promise<void> {
    if (activeSessionId === undefined || intake === undefined) return
    setIntakeError(undefined)
    try {
      const next = await window.barn.sessions.updateIntakeEmployee({
        sessionId: activeSessionId,
        employeeId,
        fields,
        expectedRevision: intake.revision,
      })
      setIntake(next)
      setIntakePreview(undefined)
      setIntakeCommitResult(undefined)
    } catch (reason) {
      setIntakeError(errorMessage(reason))
    }
  }

  async function previewIntake(): Promise<void> {
    if (activeSessionId === undefined || !requireCloudLogin()) return
    setIntakeBusy(true)
    setIntakeError(undefined)
    try {
      setIntakePreview(await window.barn.sessions.previewIntake(activeSessionId))
    } catch (reason) {
      setIntakeError(errorMessage(reason))
    } finally {
      setIntakeBusy(false)
    }
  }

  async function commitIntake(): Promise<void> {
    if (activeSessionId === undefined || intakePreview === undefined || !requireCloudLogin()) return
    const employeeIds = intakePreview.rows
      .filter((row) => row.status === 'ready')
      .map((row) => row.employeeId)
    if (employeeIds.length === 0) return
    setIntakeBusy(true)
    setIntakeError(undefined)
    try {
      const result = await window.barn.sessions.commitIntake({
        sessionId: activeSessionId,
        previewId: intakePreview.previewId,
        previewHash: intakePreview.previewHash,
        employeeIds,
      })
      setIntakeCommitResult(result)
      void loadEmployees({ page: 1, pageSize: employeeQuery.pageSize ?? 25 })
    } catch (reason) {
      setIntakeError(errorMessage(reason))
    } finally {
      setIntakeBusy(false)
    }
  }

  async function decideLifecycleProposal(decision: 'approve' | 'reject'): Promise<void> {
    if (lifecycleProposal === undefined) return
    const idempotencyKey = lifecycleDecisionKeyRef.current ?? crypto.randomUUID()
    lifecycleDecisionKeyRef.current = idempotencyKey
    setLifecycleBusy(true)
    setLifecycleError(undefined)
    try {
      const result = await window.barn.hr.decideLifecycleProposal(lifecycleProposal.id, {
        decision,
        idempotencyKey,
      })
      setLifecycleProposal(undefined)
      lifecycleDecisionKeyRef.current = undefined
      setLifecycleNotice(decision === 'reject'
        ? 'Lifecycle proposal rejected.'
        : result.proposal.status === 'approved'
          ? `Transition scheduled for ${result.proposal.effectiveDate}.`
          : `Lifecycle transition committed: ${result.employee.status}.`)
      if (employeeDetail?.id === result.employee.id) {
        setEmployeeDetail(await window.barn.hr.getEmployee(result.employee.id))
      }
      void loadEmployees()
      void loadLifecycleCases({
        status: lifecycleStatus === '' ? undefined : lifecycleStatus,
        page: lifecycleResult?.page ?? 1,
        pageSize: lifecycleResult?.pageSize ?? 25,
      })
    } catch (reason) {
      setLifecycleError(errorMessage(reason))
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function loadNotifications(): Promise<void> {
    setNotificationLoading(true)
    try {
      setNotifications(await window.barn.hr.listNotifications())
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setNotificationLoading(false)
    }
  }

  async function readNotification(notification: HrNotification): Promise<void> {
    if (notification.readAt !== undefined) return
    try {
      const updated = await window.barn.hr.markNotificationRead(notification.id)
      setNotifications((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function updateLifecycleTask(
    caseId: string,
    taskId: string,
    taskInput: LifecycleTaskUpdateInput,
  ): Promise<void> {
    try {
      await window.barn.hr.updateLifecycleTask(caseId, taskId, taskInput)
      await loadLifecycleCases({
        status: lifecycleStatus === '' ? undefined : lifecycleStatus,
        page: lifecycleResult?.page ?? 1,
        pageSize: lifecycleResult?.pageSize ?? 25,
      })
    } catch (reason) {
      setWorkspaceError(errorMessage(reason))
    }
  }

  async function cancelRun(): Promise<void> {
    const sessionId = activeSessionId ?? activeSessionIdRef.current
    if (sessionId === undefined) return
    try {
      await window.barn.sessions.cancel(sessionId)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function attachFiles(): Promise<void> {
    const sessionId = activeSessionId ?? draftSessionId()
    try {
      const selected = await window.barn.sessions.attach(sessionId)
      setAttachments((current) => [...current, ...selected])
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const defaultProvider = snapshot?.providers.find(
    (provider) => provider.id === snapshot.defaultModel?.providerId,
  )
  const modelLabel = snapshot?.defaultModel?.modelId ?? 'Choose model'
  const providerLabel = defaultProvider?.name ?? 'No provider'
  const commandKey = window.barn.platform === 'darwin' ? '⌘' : 'Ctrl'
  const running = pending || activeSession?.status === 'running'

  function draftSessionId(): string {
    draftSessionIdRef.current ??= crypto.randomUUID()
    return draftSessionIdRef.current
  }

  const appShellClassName = [
    'app-shell',
    window.barn.platform === 'darwin' ? 'platform-darwin' : '',
    sidebarOpen ? '' : 'sidebar-collapsed',
  ].filter(Boolean).join(' ')

  return (
    <div className={appShellClassName}>
      <aside
        id="app-sidebar"
        className={sidebarOpen ? 'sidebar sidebar-open' : 'sidebar'}
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-content">
          <button
            className="icon-button sidebar-toggle sidebar-toggle-sidebar"
            type="button"
            title="Hide sidebar"
            aria-label="Hide sidebar"
            aria-controls="app-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeft size={17} />
          </button>

          <div className="sidebar-top">
            <div className="brand-lockup">
              <div className="brand-mark" aria-hidden="true">
                <span />
                <span />
              </div>
              <div>
                <strong>Barn</strong>
                <span>People workspace</span>
              </div>
            </div>
          </div>

          <button className="new-session-button" type="button" onClick={startNewSession}>
          <Plus size={16} />
          New session
          <kbd>{commandKey} N</kbd>
        </button>

        <nav className="session-nav" aria-label="Sessions">
          <div className="nav-label">
            <span>Recent</span>
            <span>{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="empty-session-list">
              <Sparkles size={18} />
              <p>No sessions yet</p>
            </div>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <button
                  className={session.id === activeSessionId ? 'session-row active' : 'session-row'}
                  type="button"
                  key={session.id}
                  onClick={() => {
                    activeSessionIdRef.current = session.id
                    setActiveSessionId(session.id)
                  }}
                >
                  <span>{session.title}</span>
                  <small>{formatSessionTime(session.updatedAt)}</small>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <button className="footer-row" type="button">
            <Command size={16} />
            Commands
            <span>{commandKey} K</span>
          </button>
          <button className="footer-row" type="button" onClick={() => openWorkspace('employees')}>
            <Users size={16} />
            Employees
          </button>
          <button className="footer-row" type="button" onClick={() => openWorkspace('lifecycle')}>
            <ClipboardList size={16} />
            Lifecycle
          </button>
          <button className="footer-row" type="button" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} />
            Models
          </button>
          <div className="account-area">
            <button
              className="account-row"
              type="button"
              onClick={() => {
                if (authState.status === 'authenticated') setAccountOpen((current) => !current)
                else void login()
              }}
            >
              <span className="account-avatar">
                {authState.status === 'authenticated'
                  ? initials(authState.user?.name ?? '')
                  : <UserRound size={14} />}
              </span>
              <span className="account-copy">
                <strong>{authState.status === 'authenticated' ? authState.user?.name : authBusy ? 'Waiting for browser' : 'Sign in'}</strong>
                <small>{authState.status === 'authenticated' ? authState.user?.email : 'Barn Cloud account'}</small>
              </span>
              {authState.status === 'authenticated' ? <LogOut size={14} /> : <LogIn size={14} />}
            </button>
            {accountOpen && authState.status === 'authenticated' && (
              <div className="account-popover">
                <div>
                  <span>Tenant</span>
                  <strong>{authState.user?.tenantName}</strong>
                  <small>{authState.user?.roles.join(', ')}</small>
                </div>
                <button type="button" disabled={authBusy} onClick={() => void logout()}>
                  <LogOut size={13} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          {!sidebarOpen && (
            <button
              className="icon-button sidebar-toggle sidebar-toggle-header"
              type="button"
              title="Show sidebar"
              aria-label="Show sidebar"
              aria-controls="app-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeft size={17} />
            </button>
          )}
          <button className="model-trigger" type="button" onClick={() => setSettingsOpen(true)}>
            <span className="model-status-dot" />
            <span>
              <small>{providerLabel}</small>
              <strong>{modelLabel}</strong>
            </span>
            <SlidersHorizontal size={15} />
          </button>
          {intake !== undefined && !intakePanelOpen && (
            <button className="review-draft-trigger" type="button" onClick={() => setIntakePanelOpen(true)}>
              <ClipboardList size={14} />
              Review draft
              <span>{intake.employees.length}</span>
            </button>
          )}
          <button className="workspace-trigger" type="button" onClick={() => openWorkspace('workspace')}>
            <FolderKanban size={14} />
            Workspace
          </button>
          {authState.status === 'authenticated' && (
            <div className="notification-area">
              <button
                className="notification-trigger"
                type="button"
                aria-label="Notifications"
                onClick={() => {
                  setNotificationOpen((current) => !current)
                  if (!notificationOpen) void loadNotifications()
                }}
              >
                <Bell size={15} />
                {notifications.filter((notification) => notification.readAt === undefined).length > 0 && (
                  <span>{notifications.filter((notification) => notification.readAt === undefined).length}</span>
                )}
              </button>
              {notificationOpen && (
                <div className="notification-popover">
                  <header>
                    <strong>Notifications</strong>
                    <button type="button" onClick={() => void loadNotifications()}>
                      {notificationLoading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}
                    </button>
                  </header>
                  {notifications.length === 0 ? (
                    <p>No notifications yet.</p>
                  ) : notifications.map((notification) => (
                    <button
                      className={notification.readAt === undefined ? 'notification-row unread' : 'notification-row'}
                      type="button"
                      key={notification.id}
                      onClick={() => void readNotification(notification)}
                    >
                      <strong>{notification.title}</strong>
                      <span>{notification.body}</span>
                      <small>{formatNotificationTime(notification.createdAt)}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className={authState.status === 'authenticated' ? 'local-badge authenticated' : 'local-badge'}>
            <span />
            {authState.status === 'authenticated' ? authState.user?.tenantName ?? 'Barn Cloud' : 'Local mode'}
          </div>
        </header>

        {lifecycleNotice !== undefined && (
          <div className="lifecycle-notice" role="status">
            <CheckCircle2 size={13} />
            <span>{lifecycleNotice}</span>
            <button type="button" aria-label="Dismiss lifecycle notice" onClick={() => setLifecycleNotice(undefined)}>
              <X size={12} />
            </button>
          </div>
        )}

        <div className={intake === undefined || !intakePanelOpen ? 'workspace-body' : 'workspace-body with-intake'}>
        <section className={messages.length === 0 && liveParts.length === 0 ? 'conversation-surface empty-conversation' : 'conversation-surface chat-surface'}>
          {messages.length === 0 && liveParts.length === 0 ? (
            <div className="welcome-block">
              <div className="welcome-kicker">HRBP workspace</div>
              <h1>What needs attention?</h1>
              <p>
                Attach a roster, policy, or employee document and work through it with Barn.
                Files are read locally through the sandboxed tools.
              </p>
            </div>
          ) : (
            <div className="message-list" ref={listRef}>
              {messages.map((message) => (
                <article
                  aria-label={message.role === 'user' ? 'User message' : 'Barn message'}
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
                            <Paperclip size={11} />
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
                <article className="chat-message assistant streaming live-turn" aria-label="Barn message">
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

          <div className="composer">
            {attachments.length > 0 && (
              <div className="attachment-row">
                {attachments.map((file) => {
                  const name = attachmentDisplayName(file)
                  return (
                    <span className="attachment-chip" key={file.path}>
                      <Paperclip size={11} />
                      {name}
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            <textarea
              aria-label="Message Barn"
              placeholder="Ask Barn to build employee records from one or more files..."
              rows={4}
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
                <button className="context-chip" type="button" onClick={() => void attachFiles()}>
                  <Paperclip size={14} />
                  Attach files
                </button>
              </div>
              {running ? (
                <button className="send-button cancel" type="button" title="Stop response" onClick={() => void cancelRun()}>
                  <Square size={14} />
                </button>
              ) : (
                <button className="send-button" type="button" title="Send message" onClick={() => void sendPrompt()}>
                  <CornerDownLeft size={16} />
                </button>
              )}
            </div>
          </div>

          {messages.length === 0 && (
            <div className="suggestion-row">
              <button type="button" onClick={() => setInput('Build employee records from these files.')}>
                Build employee records
              </button>
              <button type="button" onClick={() => setInput('Review this employee roster and summarize any missing information.')}>
                Review a roster
              </button>
              <button type="button" onClick={() => setInput('Inspect the attached files and tell me what you found.')}>
                Inspect files
              </button>
            </div>
          )}
        </section>

        {intake !== undefined && intakePanelOpen && (
          <EmployeeIntakePanel
            intake={intake}
            preview={intakePreview}
            commitResult={intakeCommitResult}
            busy={intakeBusy}
            error={intakeError}
            onPreview={() => void previewIntake()}
            onCommit={() => void commitIntake()}
            onUpdate={updateIntakeEmployee}
            onClose={() => setIntakePanelOpen(false)}
          />
        )}
        </div>

        <footer className="workspace-footer">
          <span>Model calls and file tools run on this device.</span>
          <span>
            {capabilities === undefined
              ? 'Checking local capabilities'
              : capabilities.shell.available
                ? `Shell sandbox: ${capabilities.shell.backend}`
                : 'Shell sandbox unavailable'}
            {' · '}
            {snapshot === undefined ? 'Loading providers' : `${snapshot.providers.length} providers`}
            {contextStatus !== undefined && (
              <>
                {' · '}
                Context {Math.min(100, Math.round(contextStatus.tokens / contextStatus.budget * 100))}%
                {contextStatus.compacted ? ' · compacted' : ''}
              </>
            )}
          </span>
        </footer>
      </main>

      {workspaceMode !== undefined && (
        <WorkspaceDrawer
          mode={workspaceMode}
          intake={intake}
          employeeResult={employeeResult}
          employeeDetail={employeeDetail}
          lifecycleResult={lifecycleResult}
          lifecycleStatus={lifecycleStatus}
          lifecycleLoading={lifecycleLoading}
          detailLoading={employeeDetailLoading}
          loading={workspaceLoading}
          error={workspaceError}
          onMode={(mode) => {
            setWorkspaceMode(mode)
            setEmployeeDetail(undefined)
            if (mode === 'lifecycle') {
              void loadLifecycleCases({ status: lifecycleStatus === '' ? undefined : lifecycleStatus, page: 1, pageSize: 25 })
            }
          }}
          onRefresh={() => {
            if (workspaceMode === 'lifecycle') void loadLifecycleCases()
            else void loadEmployees()
          }}
          onSearch={(searchInput) => void loadEmployees({ ...searchInput, page: 1, pageSize: employeeQuery.pageSize ?? 25 })}
          onPage={(page) => void loadEmployees({ ...employeeQuery, page })}
          onSelectEmployee={(employeeId) => void openEmployee(employeeId)}
          onLifecycleStatus={(status) => {
            setLifecycleStatus(status)
            void loadLifecycleCases({ status: status === '' ? undefined : status, page: 1, pageSize: 25 })
          }}
          onLifecyclePage={(page) => void loadLifecycleCases({
            status: lifecycleStatus === '' ? undefined : lifecycleStatus,
            page,
            pageSize: lifecycleResult?.pageSize ?? 25,
          })}
          onUpdateTask={(caseId, taskId, taskInput) => void updateLifecycleTask(caseId, taskId, taskInput)}
          onReviewProposal={(proposal) => {
            lifecycleDecisionKeyRef.current = crypto.randomUUID()
            lifecycleProposalIdRef.current = undefined
            setLifecycleProposal(proposal)
            setLifecycleError(undefined)
          }}
          onClose={() => {
            setWorkspaceMode(undefined)
            setEmployeeDetail(undefined)
          }}
        />
      )}

      {lifecycleProposal !== undefined && (
        <LifecycleProposalDialog
          proposal={lifecycleProposal}
          busy={lifecycleBusy}
          error={lifecycleError}
          onDecision={(decision) => void decideLifecycleProposal(decision)}
          onClose={() => {
            setLifecycleProposal(undefined)
            setLifecycleError(undefined)
            lifecycleDecisionKeyRef.current = undefined
            lifecycleProposalIdRef.current = undefined
          }}
        />
      )}

      {settingsOpen && (
        <ModelSettings
          snapshot={snapshot}
          onSnapshot={setSnapshot}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}

function ToolGroup({ tools }: { tools: ToolCallView[] }) {
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
        <span className="tool-group-label">{toolGroupLabel(tools)}</span>
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
  return (
    <details className={`tool-row ${tool.status}`} data-part="tool">
      <summary>
        <span className="tool-row-status">
          {tool.status === 'running' && <LoaderCircle className="spin" size={12} />}
          {tool.status === 'success' && <CheckCircle2 size={12} />}
          {tool.status === 'error' && <CircleX size={12} />}
        </span>
        <span className="tool-row-label">{toolActionLabel(tool.name)}</span>
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

function toolGroupLabel(tools: ToolCallView[]): string {
  const running = tools.find((tool) => tool.status === 'running')
  if (running !== undefined) {
    const command = toolCommand(running)
    return command === undefined ? `正在${toolActionLabel(running.name).replace(/^已/, '')}` : `正在运行 ${truncate(command, 72)}`
  }
  if (tools.length === 1) return toolActionLabel(tools[0]?.name ?? '')
  if (tools.every((tool) => tool.name === 'shell')) return `运行了 ${tools.length} 条命令`
  if (tools.every((tool) => tool.name === 'read_file')) return `已读取 ${tools.length} 个文件`
  const labels = [...new Set(tools.map((tool) => toolActionLabel(tool.name)))]
  return labels.join(' · ')
}

function toolActionLabel(name: string): string {
  switch (name) {
    case 'shell': return '运行了命令'
    case 'read_file': return '已读取文件'
    case 'list_dir': return '已查看目录'
    case 'search_files': return '已搜索文件'
    case 'view_image': return '已查看图像'
    case 'employee_intake_create': return '已创建员工草稿'
    case 'employee_intake_get': return '已读取员工草稿'
    case 'employee_intake_update': return '已更新员工草稿'
    case 'employee_intake_preview': return '已校验员工草稿'
    case 'employee_list_by_org': return '已查询员工'
    case 'employee_search': return '已搜索员工'
    case 'employee_get': return '已读取员工'
    case 'org_unit_get': return '已读取组织单元'
    case 'lifecycle_propose_transition': return '已创建流程提议'
    default: return `已运行 ${name}`
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
                <span>{part.streaming === true ? 'Thinking' : 'Thought process'}</span>
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Something went wrong'
}

function formatNotificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatSessionTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${Math.round(bytes / (1_024 * 1_024) * 10) / 10} MB`
}

function initials(value: string): string {
  return value.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'B'
}
