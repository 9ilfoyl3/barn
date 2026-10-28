import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolService } from '../../src/main/tools/tool-service'
import type { ShellService } from '../../src/main/sandbox/shell-service'
import type { HrClient } from '../../src/main/cloud/hr-client'

async function createService(hrClient?: HrClient): Promise<{
  service: ToolService
  workspace: string
  output: string
  temp: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'barn-tools-'))
  const workspace = join(root, 'workspace')
  const output = join(root, 'output')
  const temp = join(root, 'temp')
  await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])
  return {
    service: new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: vi.fn() } as unknown as ShellService,
      ...(hrClient === undefined ? {} : { hrClient }),
    }),
    workspace,
    output,
    temp,
  }
}

describe('ToolService', () => {
  it('reads text with line ranges and metadata', async () => {
    const { service, workspace } = await createService()
    await writeFile(join(workspace, 'notes.txt'), 'one\ntwo\nthree\nfour')

    const result = await service.execute('read_file', {
      path: 'notes.txt',
      startLine: 2,
      lineCount: 2,
    })

    expect(result.content).toEqual([{ type: 'text', text: '2: two\n3: three' }])
    expect(result.details).toMatchObject({ totalLines: 4, truncated: true })
  })

  it('rejects paths outside managed roots and secret files', async () => {
    const { service, workspace } = await createService()
    await writeFile('/tmp/barn-outside-secret.txt', 'secret').catch(() => undefined)
    await writeFile(join(workspace, '.env'), 'TOKEN=secret')

    await expect(service.execute('read_file', { path: '/tmp/barn-outside-secret.txt' }))
      .resolves.toMatchObject({ isError: true })
    await expect(service.execute('read_file', { path: '.env' }))
      .resolves.toMatchObject({ isError: true })
  })

  it('reports binary files rather than decoding them as text', async () => {
    const { service, workspace } = await createService()
    await writeFile(join(workspace, 'roster.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))

    const result = await service.execute('read_file', { path: 'roster.pdf' })

    expect(result.content[0]?.type).toBe('text')
    expect(result.details).toMatchObject({ binary: true })
  })

  it('returns image content for supported image files', async () => {
    const { service, workspace } = await createService()
    await writeFile(join(workspace, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await service.execute('view_image', { path: 'photo.png' })

    expect(result.content).toEqual([{
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
    }])
  })

  it('exposes tenant-scoped employee reads to the Agent', async () => {
    const employee = {
      id: 'employee-1',
      employeeNo: 'E1001',
      displayName: '张三',
      status: 'active' as const,
      orgUnit: { id: 'org-1', code: 'RD', name: '研发部' },
      manager: { id: 'manager-1', employeeNo: 'M1001', displayName: '王经理' },
      hireDate: '2026-10-01',
      version: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      maskedFields: {},
      sensitiveRefs: {},
    }
    const hrClient = {
      searchEmployees: vi.fn().mockResolvedValue({
        employees: [employee],
        page: 1,
        pageSize: 25,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
      }),
      getEmployee: vi.fn().mockResolvedValue(employee),
      getOrgUnit: vi.fn().mockResolvedValue({
        id: 'org-1',
        code: 'RD',
        name: '研发部',
        effectiveFrom: '2026-01-01',
      }),
      proposeLifecycleTransition: vi.fn().mockResolvedValue({
        id: 'proposal-1',
        employeeId: 'employee-1',
        employeeNo: 'E1001',
        displayName: '张三',
        fromStatus: 'active',
        toStatus: 'offboarding',
        effectiveDate: '2026-11-01',
        reason: 'Employee resignation',
        employeeVersion: 1,
        status: 'pending_approval',
        proposedAt: '2026-10-28T10:00:00.000Z',
      }),
    } as unknown as HrClient
    const { service } = await createService(hrClient)

    const search = await service.execute('employee_search', { query: '研发部' })
    expect(search.isError).not.toBe(true)
    expect(search.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('E1001 · 张三 · active · 研发部') })
    expect(hrClient.searchEmployees).toHaveBeenCalledWith(expect.objectContaining({
      q: '研发部',
      page: 1,
      pageSize: 25,
    }))

    const detail = await service.execute('employee_get', { employeeId: 'employee-1' })
    expect(detail.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Manager: 王经理') })

    const byOrg = await service.execute('employee_list_by_org', { orgUnitCode: 'RD' })
    expect(byOrg.isError).not.toBe(true)
    expect(hrClient.searchEmployees).toHaveBeenLastCalledWith(expect.objectContaining({
      orgUnitCode: 'RD',
    }))

    const org = await service.execute('org_unit_get', { idOrCode: 'RD' })
    expect(org.details).toMatchObject({ orgUnit: { code: 'RD', name: '研发部' } })

    const proposal = await service.execute('lifecycle_propose_transition', {
      employeeId: 'E1001',
      toStatus: 'offboarding',
      effectiveDate: '2026-11-01',
      reason: 'Employee resignation',
    })
    expect(proposal.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Waiting for explicit user approval'),
    })
    expect(proposal.details).toMatchObject({ proposal: { id: 'proposal-1', status: 'pending_approval' } })
    expect(hrClient.proposeLifecycleTransition).toHaveBeenCalledWith('E1001', {
      toStatus: 'offboarding',
      effectiveDate: '2026-11-01',
      reason: 'Employee resignation',
    })
  })

  it('searches text files with bounded results', async () => {
    const { service, workspace } = await createService()
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'employees.txt'), '张三 产品部\n李四 研发部\n张三 产品部')

    const result = await service.execute('search_files', {
      path: '.',
      query: '张三',
    })

    expect(result.content).toEqual([{
      type: 'text',
      text: 'docs/employees.txt:1:张三 产品部\ndocs/employees.txt:3:张三 产品部',
    }])
  })
})
