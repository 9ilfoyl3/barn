import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  EmployeeFieldValue,
  EmployeeIntake,
  EmployeeIntakeEmployee,
  EmployeeIntakeIssue,
} from '../../shared/models'
import type { SessionStore } from '../session/session-store'

const fieldValueSchema: z.ZodType<EmployeeFieldValue> = z.object({
  value: z.string(),
  source: z.enum(['document', 'user', 'inferred']),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string()).optional(),
})

const issueSchema: z.ZodType<EmployeeIntakeIssue> = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().optional(),
})

const employeeSchema: z.ZodType<EmployeeIntakeEmployee> = z.object({
  id: z.string(),
  fields: z.record(z.string(), fieldValueSchema),
  sourceFiles: z.array(z.string()),
  status: z.enum(['ready', 'blocked']),
  issues: z.array(issueSchema),
})

const intakeSchema: z.ZodType<EmployeeIntake> = z.object({
  id: z.string(),
  sessionId: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'ready', 'blocked', 'committed']),
  employees: z.array(employeeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  committedEmployeeIds: z.array(z.string()).optional(),
  committedAt: z.string().optional(),
})

const createInputSchema = z.object({
  employees: z.array(z.object({
    id: z.string().min(1).max(200).optional(),
    fields: z.record(z.string().min(1).max(100), fieldValueSchema),
    sourceFiles: z.array(z.string().max(2_000)).max(100).default([]),
  })).min(1).max(500),
})

const updateInputSchema = z.object({
  employeeId: z.string().min(1),
  fields: z.record(z.string().min(1).max(100), z.string().max(10_000)),
  expectedRevision: z.number().int().positive(),
})

export type CreateEmployeeIntakeInput = z.infer<typeof createInputSchema>
export type UpdateEmployeeIntakeToolInput = z.infer<typeof updateInputSchema>

export class EmployeeIntakeStore {
  constructor(private readonly sessions: SessionStore) {}

  create(sessionId: string, rawInput: unknown): EmployeeIntake {
    this.sessions.getSession(sessionId)
    const input = createInputSchema.parse(rawInput)
    const now = new Date().toISOString()
    const employees = normalizeEmployees(input.employees, 'document')
    const intake = summarize({
      id: randomUUID(),
      sessionId,
      revision: 1,
      status: 'draft',
      employees,
      createdAt: now,
      updatedAt: now,
    })
    this.persist(intake)
    return intake
  }

  get(sessionId: string): EmployeeIntake | undefined {
    this.sessions.getSession(sessionId)
    const events = this.sessions.read(sessionId)
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'employee.intake.snapshot') continue
      if (!isRecord(event.data) || !('intake' in event.data)) continue
      return intakeSchema.parse(event.data.intake)
    }
    return undefined
  }

  updateEmployee(sessionId: string, rawInput: unknown, source: 'user' | 'inferred' = 'user'): EmployeeIntake {
    const input = updateInputSchema.parse(rawInput)
    const current = this.require(sessionId)
    if (current.revision !== input.expectedRevision) throw new Error('Employee intake revision is stale')
    const employees = current.employees.map((employee) => {
      if (employee.id !== input.employeeId) return employee
      const fields = { ...employee.fields }
      for (const [key, value] of Object.entries(input.fields)) {
        fields[key] = {
          value,
          source,
          evidence: fields[key]?.evidence ?? [],
        }
      }
      return normalizeEmployee({
        ...employee,
        fields,
      })
    })
    const updated = summarize({
      ...current,
      revision: current.revision + 1,
      employees,
      updatedAt: new Date().toISOString(),
    })
    this.persist(updated)
    return updated
  }

  replace(sessionId: string, employees: EmployeeIntakeEmployee[], expectedRevision: number): EmployeeIntake {
    const current = this.require(sessionId)
    if (current.revision !== expectedRevision) throw new Error('Employee intake revision is stale')
    const updated = summarize({
      ...current,
      revision: current.revision + 1,
      employees: employees.map((employee) => normalizeEmployee(employee)),
      updatedAt: new Date().toISOString(),
    })
    this.persist(updated)
    return updated
  }

  markCommitted(sessionId: string, employeeIds: string[]): EmployeeIntake {
    const current = this.require(sessionId)
    const updated: EmployeeIntake = {
      ...current,
      revision: current.revision + 1,
      status: 'committed',
      committedEmployeeIds: employeeIds,
      committedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.persist(updated)
    return updated
  }

  require(sessionId: string): EmployeeIntake {
    const intake = this.get(sessionId)
    if (intake === undefined) throw new Error('No employee intake exists in this session')
    return intake
  }

  private persist(intake: EmployeeIntake): void {
    this.sessions.append(intake.sessionId, [{
      type: 'employee.intake.snapshot',
      data: { intake },
      actor: { kind: 'agent', id: 'barn-intake' },
    }])
  }
}

function normalizeEmployees(
  employees: Array<{
    id?: string | undefined
    fields: Record<string, EmployeeFieldValue>
    sourceFiles: string[]
  }>,
  source: EmployeeFieldValue['source'],
): EmployeeIntakeEmployee[] {
  const seen = new Set<string>()
  return employees.map((input) => {
    const fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [
      key,
      { ...value, source: value.source ?? source },
    ]))
    const employee = normalizeEmployee({
      id: input.id ?? randomUUID(),
      fields,
      sourceFiles: input.sourceFiles,
      status: 'ready',
      issues: [],
    })
    if (employee.fields.employeeNo?.value !== undefined) {
      if (seen.has(employee.fields.employeeNo.value)) {
        employee.issues.push({
          code: 'duplicate_in_batch',
          field: 'employeeNo',
          message: 'Employee number is duplicated in this intake.',
        })
      }
      seen.add(employee.fields.employeeNo.value)
    }
    employee.status = employee.issues.length === 0 ? 'ready' : 'blocked'
    return employee
  })
}

function normalizeEmployee(employee: EmployeeIntakeEmployee): EmployeeIntakeEmployee {
  const issues: EmployeeIntakeIssue[] = []
  if (!employee.fields.employeeNo?.value.trim()) {
    issues.push({ code: 'employee_no_required', field: 'employeeNo', message: 'Employee number is required.' })
  }
  if (!employee.fields.displayName?.value.trim()) {
    issues.push({ code: 'display_name_required', field: 'displayName', message: 'Display name is required.' })
  }
  return {
    ...employee,
    status: issues.length === 0 ? 'ready' : 'blocked',
    issues,
  }
}

function summarize(intake: EmployeeIntake): EmployeeIntake {
  const blocked = intake.employees.some((employee) => employee.status === 'blocked')
  return {
    ...intake,
    status: blocked ? 'blocked' : 'ready',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
