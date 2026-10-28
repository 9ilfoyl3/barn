import { isUtf8 } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolExecutionResult } from '../../shared/agent-protocol'
import type { EmployeeIntake } from '../../shared/models'
import type { HrClient } from '../cloud/hr-client'
import type { EmployeeIntakeStore } from '../intake/employee-intake-store'
import type { ShellService } from '../sandbox/shell-service'
import { resolveSandboxPolicy } from '../sandbox/policy'

const readFileInput = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(5_000).optional(),
})

const listDirInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(4).default(1),
})

const searchFilesInput = z.object({
  path: z.string().default('.'),
  query: z.string().min(1).max(500),
  maxResults: z.number().int().positive().max(500).default(100),
})

const viewImageInput = z.object({
  path: z.string().min(1),
})

const employeeFieldSchema = z.object({
  value: z.string().max(10_000),
  source: z.enum(['document', 'user', 'inferred']).default('document'),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string().max(20_000)).max(50).optional(),
})

const employeeIntakeCreateInput = z.object({
  employees: z.array(z.object({
    id: z.string().min(1).max(200).optional(),
    fields: z.record(z.string().min(1).max(100), employeeFieldSchema),
    sourceFiles: z.array(z.string().max(2_000)).max(100).default([]),
  })).min(1).max(500),
})

const employeeIntakeGetInput = z.object({
  includeEmployees: z.boolean().default(true),
})

const employeeIntakeUpdateInput = z.object({
  employeeId: z.string().min(1),
  fields: z.record(z.string().min(1).max(100), z.string().max(10_000)),
  expectedRevision: z.number().int().positive(),
})

const employeeSearchInput = z.object({
  query: z.string().trim().max(200).optional(),
  status: z.enum([
    'preboarding',
    'onboarding',
    'probation',
    'active',
    'offboarding',
    'terminated',
  ]).optional(),
  orgUnitId: z.string().uuid().optional(),
  orgUnitCode: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().positive().max(100_000).default(1),
  pageSize: z.number().int().positive().max(100).default(25),
  fields: z.string().trim().max(1_000).optional(),
})

const employeeGetInput = z.object({
  employeeId: z.string().min(1).max(200),
})

const orgUnitGetInput = z.object({
  idOrCode: z.string().min(1).max(200),
})

const employeeListByOrgInput = z.object({
  orgUnitId: z.string().uuid().optional(),
  orgUnitCode: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().positive().max(100_000).default(1),
  pageSize: z.number().int().positive().max(100).default(25),
})

const lifecycleProposeInput = z.object({
  employeeId: z.string().min(1).max(200),
  toStatus: z.enum([
    'preboarding',
    'onboarding',
    'probation',
    'active',
    'offboarding',
    'terminated',
  ]),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(3).max(1_000),
})

const shellInput = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
})

const TOOL_INPUTS = {
  read_file: readFileInput,
  list_dir: listDirInput,
  search_files: searchFilesInput,
  view_image: viewImageInput,
  shell: shellInput,
  employee_intake_create: employeeIntakeCreateInput,
  employee_intake_get: employeeIntakeGetInput,
  employee_intake_update: employeeIntakeUpdateInput,
  employee_intake_preview: z.object({}),
  employee_search: employeeSearchInput,
  employee_get: employeeGetInput,
  org_unit_get: orgUnitGetInput,
  employee_list_by_org: employeeListByOrgInput,
  lifecycle_propose_transition: lifecycleProposeInput,
} as const

export interface ToolServiceOptions {
  workspaceRoot: string
  outputRoot: string
  privateTempRoot: string
  shell: ShellService
  intake?: EmployeeIntakeStore | undefined
  hrClient?: HrClient | undefined
}

export class ToolService {
  private readonly roots: string[]

  constructor(private readonly options: ToolServiceOptions) {
    this.roots = [options.workspaceRoot, options.outputRoot, options.privateTempRoot]
      .map((root) => realpathSync.native(root))
  }

  async execute(toolName: string, rawArgs: unknown, sessionId?: string): Promise<ToolExecutionResult> {
    const input = TOOL_INPUTS[toolName as keyof typeof TOOL_INPUTS]
    if (input === undefined) {
      return errorResult(`Unknown tool: ${toolName}`)
    }

    try {
      const args = input.parse(rawArgs)
      switch (toolName) {
        case 'read_file':
          return await this.readFile(args as z.infer<typeof readFileInput>)
        case 'list_dir':
          return await this.listDirectory(args as z.infer<typeof listDirInput>)
        case 'search_files':
          return await this.searchFiles(args as z.infer<typeof searchFilesInput>)
        case 'view_image':
          return await this.viewImage(args as z.infer<typeof viewImageInput>)
        case 'shell':
          return await this.runShell(args as z.infer<typeof shellInput>)
        case 'employee_intake_create':
          return this.createEmployeeIntake(requireSession(sessionId), args)
        case 'employee_intake_get':
          return this.getEmployeeIntake(requireSession(sessionId), args as z.infer<typeof employeeIntakeGetInput>)
        case 'employee_intake_update':
          return this.updateEmployeeIntake(requireSession(sessionId), args)
        case 'employee_intake_preview':
          return await this.previewEmployeeIntake(requireSession(sessionId))
        case 'employee_search':
          return await this.searchEmployees(args as z.infer<typeof employeeSearchInput>)
        case 'employee_get':
          return await this.getEmployee(args as z.infer<typeof employeeGetInput>)
        case 'org_unit_get':
          return await this.getOrgUnit(args as z.infer<typeof orgUnitGetInput>)
        case 'employee_list_by_org':
          return await this.listEmployeesByOrg(args as z.infer<typeof employeeListByOrgInput>)
        case 'lifecycle_propose_transition':
          return await this.proposeLifecycleTransition(args as z.infer<typeof lifecycleProposeInput>)
        default:
          return errorResult(`Unknown tool: ${toolName}`)
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }

  private async readFile(input: z.infer<typeof readFileInput>): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path)
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Not a file: ${input.path}`)
    if (info.size > 20 * 1024 * 1024) throw new Error('File is too large to read directly')

    const bytes = await readFile(path)
    if (!isUtf8(bytes)) {
      return {
        content: [{
          type: 'text',
          text: `Binary file: ${input.path}\nSize: ${info.size} bytes\nUse shell tools to extract text or view_image for supported image files.`,
        }],
        details: {
          path,
          size: info.size,
          binary: true,
        },
      }
    }

    const lines = bytes.toString('utf8').split(/\r?\n/)
    const startIndex = (input.startLine ?? 1) - 1
    const count = input.lineCount ?? 2_000
    const selected = lines.slice(startIndex, startIndex + count)
    const endLine = Math.min(startIndex + selected.length, lines.length)
    return {
      content: [{
        type: 'text',
        text: selected.map((line, index) => `${startIndex + index + 1}: ${line}`).join('\n'),
      }],
      details: {
        path,
        size: info.size,
        startLine: startIndex + 1,
        endLine,
        totalLines: lines.length,
        truncated: endLine < lines.length,
      },
    }
  }

  private async listDirectory(input: z.infer<typeof listDirInput>): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path)
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error(`Not a directory: ${input.path}`)
    const entries = await this.listEntries(path, input.depth)
    return {
      content: [{ type: 'text', text: entries.join('\n') || '(empty directory)' }],
      details: { path, entries: entries.length, depth: input.depth },
    }
  }

  private async searchFiles(input: z.infer<typeof searchFilesInput>): Promise<ToolExecutionResult> {
    const root = await this.safeExistingPath(input.path)
    const matches: string[] = []
    let scanned = 0
    let skipped = 0

    const visit = async (directory: string): Promise<void> => {
      if (matches.length >= input.maxResults) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (matches.length >= input.maxResults) return
        if (entry.name === 'node_modules' || entry.name === '.git') {
          skipped++
          continue
        }
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(path)
          continue
        }
        if (!entry.isFile()) continue
        const info = await stat(path)
        if (info.size > 2 * 1024 * 1024) {
          skipped++
          continue
        }
        const bytes = await readFile(path)
        if (!isUtf8(bytes)) {
          skipped++
          continue
        }
        scanned++
        const lines = bytes.toString('utf8').split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? ''
          if (line.includes(input.query)) {
            matches.push(`${relative(root, path)}:${index + 1}:${line.slice(0, 500)}`)
            if (matches.length >= input.maxResults) return
          }
        }
      }
    }

    if ((await stat(root)).isDirectory()) await visit(root)
    else throw new Error(`Not a directory: ${input.path}`)

    return {
      content: [{ type: 'text', text: matches.join('\n') || `No matches for ${JSON.stringify(input.query)}` }],
      details: { path: root, matches: matches.length, scanned, skipped },
    }
  }

  private async viewImage(input: z.infer<typeof viewImageInput>): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path)
    const mimeType = imageMimeType(path)
    if (mimeType === undefined) throw new Error(`Unsupported image type: ${extname(path) || '(none)'}`)
    const info = await stat(path)
    if (info.size > 20 * 1024 * 1024) throw new Error('Image is too large to attach')
    const bytes = await readFile(path)
    return {
      content: [{
        type: 'image',
        data: bytes.toString('base64'),
        mimeType,
      }],
      details: { path, size: info.size, mimeType },
    }
  }

  private requireIntake(): EmployeeIntakeStore {
    if (this.options.intake === undefined) throw new Error('Employee intake storage is not configured')
    return this.options.intake
  }

  private createEmployeeIntake(sessionId: string, input: unknown): ToolExecutionResult {
    const intake = this.requireIntake().create(sessionId, input)
    return this.intakeResult(intake, 'Employee intake created.')
  }

  private getEmployeeIntake(
    sessionId: string,
    input: z.infer<typeof employeeIntakeGetInput>,
  ): ToolExecutionResult {
    const intake = this.requireIntake().require(sessionId)
    const issueCount = intake.employees.reduce((count, employee) => count + employee.issues.length, 0)
    const employeeLines = input.includeEmployees
      ? intake.employees.map((employee, index) => {
        const employeeNo = employee.fields.employeeNo?.value ?? '(missing employee number)'
        const displayName = employee.fields.displayName?.value ?? '(missing name)'
        return `${index + 1}. ${employeeNo} - ${displayName} [${employee.status}]${employee.issues.length === 0 ? '' : `: ${employee.issues.map((issue) => issue.message).join('; ')}`}`
      })
      : []
    return {
      content: [{
        type: 'text',
        text: [
          `Employee intake revision ${intake.revision}: ${intake.employees.length} employees, ${intake.status}.`,
          `Issues: ${issueCount}.`,
          ...employeeLines,
        ].join('\n'),
      }],
      details: { intake },
    }
  }

  private updateEmployeeIntake(sessionId: string, input: unknown): ToolExecutionResult {
    const intake = this.requireIntake().updateEmployee(sessionId, input)
    return this.intakeResult(intake, 'Employee intake updated.')
  }

  private async previewEmployeeIntake(sessionId: string): Promise<ToolExecutionResult> {
    const intake = this.requireIntake().require(sessionId)
    const client = this.options.hrClient
    if (client === undefined) throw new Error('Barn HR API client is not configured')
    const preview = await client.preview(intake)
    const problemLines = preview.rows
      .filter((row) => row.errors.length > 0)
      .map((row) => `${row.employeeNo ?? row.employeeId}: ${row.errors.map((error) => error.message).join('; ')}`)
    return {
      content: [{
        type: 'text',
        text: [
          `Cloud preview: ${preview.summary.ready} ready, ${preview.summary.blocked} blocked out of ${preview.summary.total}.`,
          ...problemLines,
        ].join('\n'),
      }],
      details: { intake, preview },
      ...(preview.summary.blocked > 0 ? { isError: true } : {}),
    }
  }

  private async searchEmployees(input: z.infer<typeof employeeSearchInput>): Promise<ToolExecutionResult> {
    const client = this.requireHrClient()
    const result = await client.searchEmployees({
      ...(input.query === undefined ? {} : { q: input.query }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.orgUnitId === undefined ? {} : { orgUnitId: input.orgUnitId }),
      ...(input.orgUnitCode === undefined ? {} : { orgUnitCode: input.orgUnitCode }),
      page: input.page,
      pageSize: input.pageSize,
      ...(input.fields === undefined ? {} : { fields: input.fields }),
    })
    return employeeSearchResult(result)
  }

  private async getEmployee(input: z.infer<typeof employeeGetInput>): Promise<ToolExecutionResult> {
    const employee = await this.requireHrClient().getEmployee(input.employeeId)
    return {
      content: [{ type: 'text', text: employeeDetailText(employee) }],
      details: { employee },
    }
  }

  private async getOrgUnit(input: z.infer<typeof orgUnitGetInput>): Promise<ToolExecutionResult> {
    const orgUnit = await this.requireHrClient().getOrgUnit(input.idOrCode)
    return {
      content: [{ type: 'text', text: JSON.stringify(orgUnit, null, 2) }],
      details: { orgUnit },
    }
  }

  private async listEmployeesByOrg(
    input: z.infer<typeof employeeListByOrgInput>,
  ): Promise<ToolExecutionResult> {
    if (input.orgUnitId === undefined && input.orgUnitCode === undefined) {
      throw new Error('orgUnitId or orgUnitCode is required')
    }
    const result = await this.requireHrClient().searchEmployees({
      ...(input.orgUnitId === undefined ? {} : { orgUnitId: input.orgUnitId }),
      ...(input.orgUnitCode === undefined ? {} : { orgUnitCode: input.orgUnitCode }),
      page: input.page,
      pageSize: input.pageSize,
    })
    return employeeSearchResult(result)
  }

  private async proposeLifecycleTransition(
    input: z.infer<typeof lifecycleProposeInput>,
  ): Promise<ToolExecutionResult> {
    const proposal = await this.requireHrClient().proposeLifecycleTransition(input.employeeId, {
      toStatus: input.toStatus,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    })
    return {
      content: [{
        type: 'text',
        text: [
          `Lifecycle proposal created for ${proposal.displayName} (${proposal.employeeNo}).`,
          `${proposal.fromStatus} -> ${proposal.toStatus}, effective ${proposal.effectiveDate}.`,
          'Waiting for explicit user approval; no lifecycle state has changed.',
        ].join('\n'),
      }],
      details: { proposal },
    }
  }

  private requireHrClient(): HrClient {
    if (this.options.hrClient === undefined) throw new Error('Barn HR API client is not configured')
    return this.options.hrClient
  }

  private intakeResult(intake: EmployeeIntake, message: string): ToolExecutionResult {
    const blocked = intake.employees.filter((employee) => employee.status === 'blocked').length
    return {
      content: [{
        type: 'text',
        text: `${message} revision=${intake.revision}, employees=${intake.employees.length}, blocked=${blocked}.`,
      }],
      details: { intake },
    }
  }

  private async runShell(input: z.infer<typeof shellInput>): Promise<ToolExecutionResult> {
    const cwd = await this.safeExistingPath(input.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${input.cwd}`)
    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: this.options.workspaceRoot,
      outputRoot: this.options.outputRoot,
      privateTempRoot: this.options.privateTempRoot,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    const result = await this.options.shell.run({
      command: input.command,
      cwd,
      policy,
    })
    const text = [
      `Exit code: ${result.exitCode ?? 'unknown'}`,
      result.stdout.length > 0 ? `\nSTDOUT\n${result.stdout}` : '',
      result.stderr.length > 0 ? `\nSTDERR\n${result.stderr}` : '',
      result.timedOut ? '\nTimed out.' : '',
      result.aborted ? '\nAborted.' : '',
    ].join('')
    return {
      content: [{ type: 'text', text }],
      details: {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        sandbox: result.sandbox,
      },
      ...(result.exitCode === 0 ? {} : { isError: true }),
    }
  }

  private async safeExistingPath(input: string): Promise<string> {
    const candidate = isAbsolute(input) ? input : resolve(this.options.workspaceRoot, input)
    const canonical = await realpath(candidate)
    this.assertAllowed(canonical)
    return canonical
  }

  private assertAllowed(path: string): void {
    if (isDeniedPath(path)) throw new Error('Access to this path is denied')
    const allowed = this.roots.some((root) => {
      const rel = relative(root, path)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    })
    if (!allowed) throw new Error('Path is outside the managed workspace')
  }

  private async listEntries(root: string, depth: number): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true })
    const lines: string[] = []
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(root, entry.name)
      if (entry.isDirectory()) {
        lines.push(`${relative(this.options.workspaceRoot, path)}/`)
        if (depth > 0) {
          const children = await this.listEntries(path, depth - 1)
          lines.push(...children.map((child) => `${relative(this.options.workspaceRoot, path)}/${child}`))
        }
      } else {
        const info = await stat(path)
        lines.push(`${relative(this.options.workspaceRoot, path)} (${info.size} bytes)`)
      }
    }
    return lines
  }
}

function imageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

function isDeniedPath(path: string): boolean {
  const name = basename(path).toLowerCase()
  return name === '.env'
    || name.startsWith('.env.')
    || name === 'credentials'
    || name === 'id_rsa'
    || name === 'id_ed25519'
    || name.includes('keychain')
}

function employeeSearchResult(result: Awaited<ReturnType<HrClient['searchEmployees']>>): ToolExecutionResult {
  const lines = result.employees.map((employee) => {
    const org = employee.orgUnit?.name === undefined ? '' : ` · ${employee.orgUnit.name}`
    const manager = employee.manager?.displayName === undefined ? '' : ` · manager ${employee.manager.displayName}`
    return `- ${employee.employeeNo ?? employee.id} · ${employee.displayName ?? '(unnamed)'} · ${employee.status ?? 'unknown'}${org}${manager}`
  })
  return {
    content: [{
      type: 'text',
      text: [
        `${result.total} employee(s), page ${result.page} of ${Math.max(1, result.totalPages)}.${result.cache?.source === 'cache' ? ' Read-only cached data.' : ''}`,
        ...lines,
      ].join('\n'),
    }],
    details: { result },
  }
}

function employeeDetailText(employee: Awaited<ReturnType<HrClient['getEmployee']>>): string {
  return [
    `${employee.displayName ?? '(unnamed)'} (${employee.employeeNo ?? employee.id})`,
    `Status: ${employee.status ?? 'unknown'}`,
    `Version: ${employee.version}`,
    `Hire date: ${employee.hireDate ?? 'unknown'}`,
    `Organization: ${employee.orgUnit?.name ?? 'unassigned'}`,
    `Job: ${employee.jobTitle ?? 'unknown'}`,
    `Location: ${employee.location ?? 'unknown'}`,
    `Manager: ${employee.manager?.displayName ?? 'unassigned'}`,
    `Work email: ${employee.workEmail ?? 'not provided'}`,
    ...(employee.cache?.source === 'cache' ? ['Data source: read-only encrypted cache'] : []),
  ].join('\n')
}

function errorResult(message: string): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
    isError: true,
  }
}

function requireSession(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId.length === 0) throw new Error('Session ID is required')
  return sessionId
}
