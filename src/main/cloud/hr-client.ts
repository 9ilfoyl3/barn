import type {
  EmployeeDetail,
  EmployeeIntake,
  EmployeeIntakeCommitResult,
  EmployeeIntakePreview,
  EmployeeLifecycleState,
  EmployeeSearchInput,
  EmployeeSearchResult,
  HrNotification,
  HrReadMetadata,
  LifecycleCaseSearchInput,
  LifecycleCaseSearchResult,
  LifecycleCaseSummary,
  LifecycleDecisionInput,
  LifecycleDecisionResult,
  LifecycleProposal,
  LifecycleProposalRequest,
  LifecycleTask,
  LifecycleTaskTemplate,
  LifecycleTaskTemplateInput,
  LifecycleTaskTemplateUpdateInput,
  LifecycleTaskUpdateInput,
  OrgUnitDetail,
} from '../../shared/models'
import type { HrReadCache, HrReadCacheScope } from './hr-read-cache'

export interface HrClientOptions {
  cache?: HrReadCache | undefined
  getAuthScope?: (() => HrReadCacheScope | undefined) | undefined
}

function withCacheMetadata<T extends object>(value: T, metadata: HrReadMetadata): T {
  return { ...value, cache: metadata }
}

function canonicalInput(input: EmployeeSearchInput): Record<string, string | number> {
  return canonicalRecord(input)
}

function canonicalRecord(input: object): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  )
}

function cacheKey(kind: string, value: string | Record<string, string | number>): string {
  return `${kind}:${typeof value === 'string' ? value : JSON.stringify(value)}`
}

export class HrClient {
  private readonly baseUrl: string

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    baseUrl?: string,
    private readonly options: HrClientOptions = {},
  ) {
    this.baseUrl = baseUrl ?? process.env.BARN_HR_API_URL ?? 'http://127.0.0.1:3200'
  }

  async preview(intake: EmployeeIntake): Promise<EmployeeIntakePreview> {
    return this.request<EmployeeIntakePreview>('/v1/hr/employee-intakes/preview', {
      method: 'POST',
      body: JSON.stringify({
        employees: intake.employees.map((employee) => ({
          id: employee.id,
          fields: employee.fields,
          sourceFiles: employee.sourceFiles,
        })),
      }),
    })
  }

  async commit(input: {
    previewId: string
    previewHash: string
    employeeIds: string[]
  }): Promise<EmployeeIntakeCommitResult> {
    const result = await this.request<EmployeeIntakeCommitResult>(
      `/v1/hr/employee-intakes/${encodeURIComponent(input.previewId)}/commit`,
      {
        method: 'POST',
        body: JSON.stringify({
          previewHash: input.previewHash,
          employeeIds: input.employeeIds,
        }),
      },
    )
    await this.clearCurrentCache()
    return result
  }

  async listEmployees(): Promise<EmployeeIntakeCommitResult['employees']> {
    const result = await this.searchEmployees({ page: 1, pageSize: 100 })
    return result.employees.map((employee) => ({
      id: employee.id,
      employeeNo: employee.employeeNo ?? '',
      displayName: employee.displayName ?? '',
      ...(employee.workEmail === undefined ? {} : { workEmail: employee.workEmail }),
    }))
  }

  async searchEmployees(input: EmployeeSearchInput = {}): Promise<EmployeeSearchResult> {
    const query = new URLSearchParams()
    if (input.q !== undefined && input.q.length > 0) query.set('q', input.q)
    if (input.status !== undefined) query.set('status', input.status)
    if (input.orgUnitId !== undefined) query.set('orgUnitId', input.orgUnitId)
    if (input.orgUnitCode !== undefined) query.set('orgUnitCode', input.orgUnitCode)
    if (input.page !== undefined) query.set('page', String(input.page))
    if (input.pageSize !== undefined) query.set('pageSize', String(input.pageSize))
    if (input.fields !== undefined) query.set('fields', input.fields)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const key = cacheKey('employee-search', canonicalInput(input))
    return this.readThrough(key, () => this.request<EmployeeSearchResult>(`/v1/hr/employees${suffix}`))
  }

  async getEmployee(employeeId: string): Promise<EmployeeDetail> {
    return this.readThrough(
      cacheKey('employee', employeeId),
      () => this.request<EmployeeDetail>(`/v1/hr/employees/${encodeURIComponent(employeeId)}`),
    )
  }

  async getOrgUnit(idOrCode: string): Promise<OrgUnitDetail> {
    return this.readThrough(
      cacheKey('org-unit', idOrCode),
      () => this.request<OrgUnitDetail>(`/v1/hr/org-units/${encodeURIComponent(idOrCode)}`),
    )
  }

  async getLifecycle(employeeId: string): Promise<EmployeeLifecycleState> {
    return this.readThrough(
      cacheKey('employee-lifecycle', employeeId),
      () => this.request<EmployeeLifecycleState>(`/v1/hr/employees/${encodeURIComponent(employeeId)}/lifecycle`),
    )
  }

  async proposeLifecycleTransition(
    employeeId: string,
    input: LifecycleProposalRequest,
  ): Promise<LifecycleProposal> {
    const proposal = await this.request<LifecycleProposal>(
      `/v1/hr/employees/${encodeURIComponent(employeeId)}/lifecycle/proposals`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    await this.clearCurrentCache()
    return proposal
  }

  async decideLifecycleProposal(
    proposalId: string,
    input: LifecycleDecisionInput,
  ): Promise<LifecycleDecisionResult> {
    const result = await this.request<LifecycleDecisionResult>(
      `/v1/hr/lifecycle-proposals/${encodeURIComponent(proposalId)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    await this.clearCurrentCache()
    return result
  }

  async listLifecycleCases(input: LifecycleCaseSearchInput = {}): Promise<LifecycleCaseSearchResult> {
    const query = new URLSearchParams()
    if (input.status !== undefined) query.set('status', input.status)
    if (input.employeeId !== undefined) query.set('employeeId', input.employeeId)
    if (input.page !== undefined) query.set('page', String(input.page))
    if (input.pageSize !== undefined) query.set('pageSize', String(input.pageSize))
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.readThrough(
      cacheKey('lifecycle-cases', canonicalRecord(input)),
      () => this.request<LifecycleCaseSearchResult>(`/v1/hr/lifecycle-cases${suffix}`),
    )
  }

  async getLifecycleCase(caseId: string): Promise<LifecycleCaseSummary> {
    return this.readThrough(
      cacheKey('lifecycle-case', caseId),
      () => this.request<LifecycleCaseSummary>(`/v1/hr/lifecycle-cases/${encodeURIComponent(caseId)}`),
    )
  }

  async listLifecycleTaskTemplates(): Promise<LifecycleTaskTemplate[]> {
    return this.readThrough(
      cacheKey('lifecycle-task-templates', {}),
      () => this.request<LifecycleTaskTemplate[]>('/v1/hr/lifecycle-task-templates'),
    )
  }

  async createLifecycleTaskTemplate(input: LifecycleTaskTemplateInput): Promise<LifecycleTaskTemplate> {
    const template = await this.request<LifecycleTaskTemplate>('/v1/hr/lifecycle-task-templates', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    await this.clearCurrentCache()
    return template
  }

  async updateLifecycleTaskTemplate(
    templateId: string,
    input: LifecycleTaskTemplateUpdateInput,
  ): Promise<LifecycleTaskTemplate> {
    const template = await this.request<LifecycleTaskTemplate>(
      `/v1/hr/lifecycle-task-templates/${encodeURIComponent(templateId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    await this.clearCurrentCache()
    return template
  }

  async updateLifecycleTask(
    caseId: string,
    taskId: string,
    input: LifecycleTaskUpdateInput,
  ): Promise<LifecycleTask> {
    const task = await this.request<LifecycleTask>(
      `/v1/hr/lifecycle-cases/${encodeURIComponent(caseId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    await this.clearCurrentCache()
    return task
  }

  async listNotifications(unreadOnly = false): Promise<HrNotification[]> {
    const query = unreadOnly ? '?unreadOnly=true' : ''
    return this.request<HrNotification[]>(`/v1/hr/notifications${query}`)
  }

  async markNotificationRead(notificationId: string): Promise<HrNotification> {
    return this.request<HrNotification>(
      `/v1/hr/notifications/${encodeURIComponent(notificationId)}/read`,
      { method: 'POST' },
    )
  }

  private async clearCurrentCache(): Promise<void> {
    const scope = this.options.getAuthScope?.()
    if (scope !== undefined) await this.options.cache?.clearScope(scope).catch(() => undefined)
  }

  private async readThrough<T extends object>(key: string, load: () => Promise<T>): Promise<T> {
    const cache = this.options.cache
    const scope = this.options.getAuthScope?.()
    if (cache === undefined || scope === undefined) return load()

    await cache.activate(scope).catch(() => undefined)
    const cached = await cache.get<T>(scope, key).catch(() => undefined)
    if (cached !== undefined) {
      return withCacheMetadata(cached.data, { source: 'cache', ...cached.metadata })
    }

    const loaded = await load()
    const metadata = await cache.put(scope, key, loaded).catch(() => undefined)
    return metadata === undefined ? loaded : withCacheMetadata(loaded, { source: 'network', ...metadata })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const accessToken = await this.getAccessToken()
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Barn HR API ${response.status}: ${body.slice(0, 1_000)}`)
    }
    return response.json() as Promise<T>
  }
}
