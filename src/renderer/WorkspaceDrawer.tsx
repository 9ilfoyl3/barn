import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ClipboardList,
  Database,
  ChevronRight,
  LoaderCircle,
  Mail,
  MapPin,
  RefreshCw,
  Search,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import type {
  EmployeeDetail,
  EmployeeIntake,
  EmployeeLifecycleStatus,
  EmployeeSearchInput,
  EmployeeSearchResult,
  EmployeeSummary,
  LifecycleCaseSearchResult,
  LifecycleCaseStatus,
  LifecycleProposal,
  LifecycleTask,
  LifecycleTaskUpdateInput,
} from '../shared/models'

interface WorkspaceDrawerProps {
  mode: 'workspace' | 'employees' | 'lifecycle'
  intake: EmployeeIntake | undefined
  employeeResult: EmployeeSearchResult | undefined
  employeeDetail: EmployeeDetail | undefined
  lifecycleResult: LifecycleCaseSearchResult | undefined
  lifecycleStatus: '' | LifecycleCaseStatus
  lifecycleLoading: boolean
  detailLoading: boolean
  loading: boolean
  error: string | undefined
  onMode(mode: 'workspace' | 'employees' | 'lifecycle'): void
  onRefresh(): void
  onSearch(input: EmployeeSearchInput): void
  onPage(page: number): void
  onSelectEmployee(employeeId: string): void
  onLifecycleStatus(status: '' | LifecycleCaseStatus): void
  onLifecyclePage(page: number): void
  onReviewProposal(proposal: LifecycleProposal): void
  onUpdateTask(caseId: string, taskId: string, input: LifecycleTaskUpdateInput): void
  onClose(): void
}

const LIFECYCLE_CASE_STATUS_OPTIONS: Array<{ value: '' | LifecycleCaseStatus; label: string }> = [
  { value: '', label: 'All cases' },
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'blocked', label: 'Blocked' },
]

const STATUS_OPTIONS: Array<{ value: '' | EmployeeLifecycleStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'preboarding', label: 'Preboarding' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'probation', label: 'Probation' },
  { value: 'active', label: 'Active' },
  { value: 'offboarding', label: 'Offboarding' },
  { value: 'terminated', label: 'Terminated' },
]

export function WorkspaceDrawer({
  mode,
  intake,
  employeeResult,
  employeeDetail,
  lifecycleResult,
  lifecycleStatus,
  lifecycleLoading,
  detailLoading,
  loading,
  error,
  onMode,
  onRefresh,
  onSearch,
  onPage,
  onSelectEmployee,
  onLifecycleStatus,
  onLifecyclePage,
  onReviewProposal,
  onUpdateTask,
  onClose,
}: WorkspaceDrawerProps) {
  const employeesRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | EmployeeLifecycleStatus>('')
  const [orgUnitCode, setOrgUnitCode] = useState('')

  useEffect(() => {
    if (mode === 'employees') employeesRef.current?.scrollIntoView({ block: 'start' })
  }, [mode])

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSearch({
      ...(query.trim().length === 0 ? {} : { q: query.trim() }),
      ...(status === '' ? {} : { status }),
      ...(orgUnitCode.trim().length === 0 ? {} : { orgUnitCode: orgUnitCode.trim() }),
    })
  }

  const employees = employeeResult?.employees ?? []

  return (
    <div className="workspace-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="workspace-drawer"
        aria-label="Workspace"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-drawer-header">
          <div>
            <span>Barn workspace</span>
            <h2>Workspace</h2>
          </div>
          <div className="workspace-drawer-header-actions">
            <button className="icon-button" type="button" title="Refresh workspace" onClick={onRefresh}>
              {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            </button>
            <button className="icon-button" type="button" title="Close workspace" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </header>

        <nav className="workspace-tabs" aria-label="Workspace sections">
          <button
            className={mode === 'workspace' ? 'active' : ''}
            type="button"
            onClick={() => onMode('workspace')}
          >
            <BriefcaseBusiness size={14} />
            Current work
          </button>
          <button
            className={mode === 'employees' ? 'active' : ''}
            type="button"
            onClick={() => onMode('employees')}
          >
            <Users size={14} />
            Employees
            <span>{employeeResult?.total ?? employees.length}</span>
          </button>
          <button
            className={mode === 'lifecycle' ? 'active' : ''}
            type="button"
            onClick={() => onMode('lifecycle')}
          >
            <ClipboardList size={14} />
            Lifecycle
            <span>{lifecycleResult?.total ?? 0}</span>
          </button>
        </nav>

        {error !== undefined && <div className="workspace-error">{error}</div>}

        <div className="workspace-drawer-body">
          {mode === 'workspace' && (
            <section className="workspace-section workspace-current">
              <div className="workspace-section-heading">
                <div>
                  <span>Current work</span>
                  <h3>{intake === undefined ? 'No active employee intake' : 'Employee intake in progress'}</h3>
                </div>
                {intake !== undefined && (
                  <span className={`workspace-status ${intake.status}`}>{intake.status}</span>
                )}
              </div>

              {intake === undefined ? (
                <p className="workspace-empty-copy">
                  When Barn creates employee drafts, they will appear here with field status,
                  source files, validation problems, and commit progress.
                </p>
              ) : (
                <>
                  <div className="workspace-stats">
                    <div><strong>{intake.employees.length}</strong><span>Drafts</span></div>
                    <div><strong>{intake.employees.filter((employee) => employee.status === 'ready').length}</strong><span>Ready</span></div>
                    <div><strong>{intake.employees.filter((employee) => employee.status === 'blocked').length}</strong><span>Blocked</span></div>
                  </div>
                  <div className="workspace-employee-list">
                    {intake.employees.map((employee, index) => (
                      <div className="workspace-employee-row" key={employee.id}>
                        <span className="workspace-row-index">{String(index + 1).padStart(2, '0')}</span>
                        <span>
                          <strong>{employee.fields.displayName?.value || 'Unnamed employee'}</strong>
                          <small>{employee.fields.employeeNo?.value || 'Missing employee number'}</small>
                        </span>
                        <span className={`workspace-status ${employee.status}`}>{employee.status}</span>
                      </div>
                    ))}
                  </div>
                  {intake.employees.some((employee) => employee.sourceFiles.length > 0) && (
                    <div className="workspace-source-files">
                      <span>Source files</span>
                      {[...new Set(intake.employees.flatMap((employee) => employee.sourceFiles))].map((file) => (
                        <code key={file}>{shortPath(file)}</code>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {mode !== 'lifecycle' && (
          <section className="workspace-section workspace-employees" ref={employeesRef}>
            <div className="workspace-section-heading">
              <div>
                <span>Barn Cloud · current tenant</span>
                <h3>{employeeDetail === undefined ? 'Employees' : 'Employee details'}</h3>
              </div>
              <div className="workspace-heading-badges">
                {employeeResult?.cache?.source === 'cache' && (
                  <span className="workspace-cache-badge" title="Read-only encrypted cache">
                    <Database size={10} /> Cached
                  </span>
                )}
                <span className="workspace-count">{employeeResult?.total ?? employees.length}</span>
              </div>
            </div>

            {employeeDetail === undefined ? (
              <>
                <form className="employee-search-form" onSubmit={submitSearch}>
                  <label>
                    <Search size={14} />
                    <input
                      aria-label="Search employees"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Name, employee no, email or organization"
                    />
                  </label>
                  <div className="employee-filter-row">
                    <select
                      aria-label="Employee status"
                      value={status}
                      onChange={(event) => setStatus(event.target.value as '' | EmployeeLifecycleStatus)}
                    >
                      {STATUS_OPTIONS.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <input
                      aria-label="Organization code"
                      value={orgUnitCode}
                      onChange={(event) => setOrgUnitCode(event.target.value)}
                      placeholder="Org code"
                    />
                    <button type="submit">Search</button>
                  </div>
                </form>

                {loading && employees.length === 0 ? (
                  <div className="workspace-loading"><LoaderCircle className="spin" size={16} /> Loading employees</div>
                ) : employees.length === 0 ? (
                  <p className="workspace-empty-copy">No employees match this search in the current tenant.</p>
                ) : (
                  <div className="workspace-employee-list">
                    {employees.map((employee) => (
                      <button
                        className="workspace-employee-row added employee-result-row"
                        type="button"
                        key={employee.id}
                        onClick={() => onSelectEmployee(employee.id)}
                      >
                        <span className="workspace-avatar">{initials(employee.displayName ?? '')}</span>
                        <span>
                          <strong>{employee.displayName ?? '(unnamed)'}</strong>
                          <small>{employeeSummaryLine(employee)}</small>
                        </span>
                        {employee.status !== undefined && (
                          <span className={`workspace-status ${employee.status}`}>{employee.status}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {employeeResult !== undefined && employeeResult.totalPages > 1 && (
                  <div className="employee-pagination">
                    <button
                      type="button"
                      title="Previous employee page"
                      disabled={employeeResult.page <= 1 || loading}
                      onClick={() => onPage(employeeResult.page - 1)}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span>Page {employeeResult.page} of {employeeResult.totalPages}</span>
                    <button
                      type="button"
                      title="Next employee page"
                      disabled={!employeeResult.hasNextPage || loading}
                      onClick={() => onPage(employeeResult.page + 1)}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <EmployeeDetailPanel
                employee={employeeDetail}
                loading={detailLoading}
                onBack={() => onMode('employees')}
              />
            )}
          </section>
          )}

          {mode === 'lifecycle' && (
            <section className="workspace-section workspace-lifecycle">
              <div className="workspace-section-heading">
                <div>
                  <span>Barn Cloud · lifecycle</span>
                  <h3>Lifecycle cases</h3>
                </div>
                <div className="workspace-heading-badges">
                  {lifecycleResult?.cache?.source === 'cache' && (
                    <span className="workspace-cache-badge"><Database size={10} /> Cached</span>
                  )}
                  <span className="workspace-count">{lifecycleResult?.total ?? 0}</span>
                </div>
              </div>

              <div className="lifecycle-case-filter">
                <select
                  aria-label="Lifecycle case status"
                  value={lifecycleStatus}
                  onChange={(event) => onLifecycleStatus(event.target.value as '' | LifecycleCaseStatus)}
                >
                  {LIFECYCLE_CASE_STATUS_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              {lifecycleLoading && (lifecycleResult?.cases.length ?? 0) === 0 ? (
                <div className="workspace-loading"><LoaderCircle className="spin" size={16} /> Loading lifecycle cases</div>
              ) : (lifecycleResult?.cases.length ?? 0) === 0 ? (
                <p className="workspace-empty-copy">No lifecycle cases match this filter.</p>
              ) : (
                <div className="lifecycle-case-list">
                  {lifecycleResult?.cases.map((lifecycleCase) => (
                    <article className="lifecycle-case-card" key={lifecycleCase.id}>
                      <header>
                        <div>
                          <strong>{lifecycleCase.displayName}</strong>
                          <span>{lifecycleCase.employeeNo}</span>
                        </div>
                        <span className={`workspace-status ${lifecycleCase.status}`}>{lifecycleCase.status.replaceAll('_', ' ')}</span>
                      </header>
                      {lifecycleCase.transition !== undefined && (
                        <div className="lifecycle-case-transition">
                          <span className={`workspace-status ${lifecycleCase.transition.fromStatus}`}>{lifecycleCase.transition.fromStatus}</span>
                          <span>→</span>
                          <span className={`workspace-status ${lifecycleCase.transition.toStatus}`}>{lifecycleCase.transition.toStatus}</span>
                        </div>
                      )}
                      <p>{lifecycleCase.transition?.reason ?? lifecycleCase.caseType}</p>
                      <div className="lifecycle-case-meta">
                        <span>{formatDate(lifecycleCase.openedAt)}</span>
                        <span>
                          {lifecycleCase.tasks.filter((task) => task.status === 'completed').length}
                          /{lifecycleCase.tasks.length} tasks complete
                        </span>
                      </div>
                      {lifecycleCase.tasks.length > 0 && (
                        <div className="lifecycle-task-list">
                          {lifecycleCase.tasks.map((task) => (
                            <LifecycleTaskEditor
                              key={task.id}
                              task={task}
                              onSave={(input) => onUpdateTask(lifecycleCase.id, task.id, input)}
                            />
                          ))}
                        </div>
                      )}
                      {lifecycleCase.status === 'pending_approval' && lifecycleCase.transition !== undefined && (
                        <button
                          className="lifecycle-case-review"
                          type="button"
                          onClick={() => onReviewProposal(lifecycleCase.transition!)}
                        >
                          <CheckCircle2 size={13} />
                          Review approval
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {lifecycleResult !== undefined && lifecycleResult.totalPages > 1 && (
                <div className="employee-pagination">
                  <button
                    type="button"
                    title="Previous lifecycle page"
                    disabled={lifecycleResult.page <= 1 || lifecycleLoading}
                    onClick={() => onLifecyclePage(lifecycleResult.page - 1)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>Page {lifecycleResult.page} of {lifecycleResult.totalPages}</span>
                  <button
                    type="button"
                    title="Next lifecycle page"
                    disabled={!lifecycleResult.hasNextPage || lifecycleLoading}
                    onClick={() => onLifecyclePage(lifecycleResult.page + 1)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}

function LifecycleTaskEditor({
  task,
  onSave,
}: {
  task: LifecycleTask
  onSave(input: LifecycleTaskUpdateInput): void
}) {
  const [status, setStatus] = useState<LifecycleTask['status']>(task.status)
  const [assignee, setAssignee] = useState(task.assigneeUserId ?? '')

  return (
    <div className="lifecycle-task-row">
      <div>
        <strong>{task.title}</strong>
        <small>{task.assigneeRole ?? 'unassigned role'}{task.dueAt === undefined ? '' : ` · due ${task.dueAt}`}</small>
      </div>
      <select
        aria-label={`Status for ${task.title}`}
        value={status}
        onChange={(event) => setStatus(event.target.value as LifecycleTask['status'])}
      >
        <option value="pending">Pending</option>
        <option value="completed">Completed</option>
        <option value="blocked">Blocked</option>
      </select>
      <input
        aria-label={`Assignee for ${task.title}`}
        value={assignee}
        placeholder="Assignee user ID"
        onChange={(event) => setAssignee(event.target.value)}
      />
      <button
        type="button"
        aria-label={`Save task ${task.title}`}
        onClick={() => onSave({
          status,
          assigneeUserId: assignee.trim().length === 0 ? null : assignee.trim(),
        })}
      >
        Save
      </button>
    </div>
  )
}

function EmployeeDetailPanel({
  employee,
  loading,
  onBack,
}: {
  employee: EmployeeDetail
  loading: boolean
  onBack(): void
}) {
  return (
    <div className="employee-detail">
      <button className="employee-detail-back" type="button" onClick={onBack}>
        <ArrowLeft size={13} />
        Back to employees
      </button>
      <div className="employee-detail-heading">
        <span className="workspace-avatar large">{initials(employee.displayName ?? '')}</span>
        <div>
          <h4>{employee.displayName ?? '(unnamed)'}</h4>
          <p>{employee.employeeNo ?? employee.id}</p>
        </div>
        {employee.status !== undefined && (
          <span className={`workspace-status ${employee.status}`}>{employee.status}</span>
        )}
      </div>
      {employee.cache?.source === 'cache' && (
        <div className="workspace-cache-badge inline">
          <Database size={11} /> Read-only cached data · expires {formatDate(employee.cache.expiresAt)}
        </div>
      )}
      {loading && <div className="workspace-loading"><LoaderCircle className="spin" size={14} /> Refreshing</div>}
      <dl className="employee-detail-grid">
        <DetailItem icon={<Building2 size={13} />} label="Organization" value={employee.orgUnit?.name ?? 'Unassigned'} />
        <DetailItem icon={<BriefcaseBusiness size={13} />} label="Job" value={employee.jobTitle ?? 'Not set'} />
        <DetailItem icon={<UserRound size={13} />} label="Manager" value={employee.manager?.displayName ?? 'Unassigned'} />
        <DetailItem icon={<CalendarDays size={13} />} label="Hire date" value={employee.hireDate ?? 'Not set'} />
        <DetailItem icon={<MapPin size={13} />} label="Location" value={employee.location ?? 'Not set'} />
        <DetailItem icon={<Mail size={13} />} label="Work email" value={employee.workEmail ?? 'Not provided'} />
      </dl>
      <div className="employee-detail-meta">
        <span>Version {employee.version}</span>
        <span>Updated {formatDate(employee.updatedAt)}</span>
      </div>
    </div>
  )
}

function DetailItem({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div>
      <dt>{icon}{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function employeeSummaryLine(employee: EmployeeSummary): string {
  const parts = [employee.employeeNo, employee.orgUnit?.name, employee.jobTitle].filter(
    (part): part is string => part !== undefined && part.length > 0,
  )
  return parts.join(' · ') || employee.workEmail || 'No organization assignment'
}

function initials(value: string): string {
  return value.trim().slice(0, 2).toUpperCase() || '—'
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.slice(-2).join('/')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}
