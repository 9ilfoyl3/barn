import { useEffect, useState } from 'react'
import { Check, Cloud, LoaderCircle, Save, Users, X } from 'lucide-react'
import type {
  EmployeeIntake,
  EmployeeIntakeCommitResult,
  EmployeeIntakePreview,
} from '../shared/models'

interface EmployeeIntakePanelProps {
  intake: EmployeeIntake
  preview: EmployeeIntakePreview | undefined
  commitResult: EmployeeIntakeCommitResult | undefined
  busy: boolean
  error: string | undefined
  onPreview(): void
  onCommit(): void
  onUpdate(employeeId: string, fields: Record<string, string>): Promise<void>
  onClose(): void
}

const FIELD_DEFINITIONS = [
  { key: 'employeeNo', label: 'Employee number', required: true },
  { key: 'displayName', label: 'Display name', required: true },
  { key: 'workEmail', label: 'Work email' },
  { key: 'hireDate', label: 'Hire date' },
  { key: 'orgUnit', label: 'Organization' },
] as const

export function EmployeeIntakePanel({
  intake,
  preview,
  commitResult,
  busy,
  error,
  onPreview,
  onCommit,
  onUpdate,
  onClose,
}: EmployeeIntakePanelProps) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(intake.employees[0]?.id)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const selectedEmployee = intake.employees.find((employee) => employee.id === selectedEmployeeId)
    ?? intake.employees[0]

  useEffect(() => {
    if (selectedEmployee === undefined) return
    if (selectedEmployee.id !== selectedEmployeeId) setSelectedEmployeeId(selectedEmployee.id)
    setFormValues(Object.fromEntries(FIELD_DEFINITIONS.map((field) => [
      field.key,
      selectedEmployee.fields[field.key]?.value ?? '',
    ])))
  }, [intake.revision, selectedEmployeeId])

  const readyCount = intake.employees.filter((employee) => employee.status === 'ready').length
  const blockedCount = intake.employees.length - readyCount
  const previewByEmployee = new Map(preview?.rows.map((row) => [row.employeeId, row]) ?? [])
  const committableIds = preview?.rows
    .filter((row) => row.status === 'ready')
    .map((row) => row.employeeId) ?? []
  const committed = intake.status === 'committed'

  async function saveEmployee(): Promise<void> {
    if (selectedEmployee === undefined) return
    setSaving(true)
    try {
      await onUpdate(selectedEmployee.id, formValues)
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className="intake-panel" aria-label="Employee intake">
      <header className="intake-header">
        <div>
          <span>Employee intake</span>
          <h2>Review drafts</h2>
        </div>
        <button className="icon-button" type="button" title="Close employee intake" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <div className="intake-summary">
        <div>
          <strong>{intake.employees.length}</strong>
          <span>Employees</span>
        </div>
        <div>
          <strong className="ready">{readyCount}</strong>
          <span>Ready</span>
        </div>
        <div>
          <strong className={blockedCount > 0 ? 'blocked' : ''}>{blockedCount}</strong>
          <span>Blocked</span>
        </div>
      </div>

      {(error !== undefined || committed || commitResult !== undefined) && (
        <div className={error !== undefined ? 'intake-notice error' : 'intake-notice success'}>
          {error ?? `Created ${commitResult?.employees.length ?? intake.committedEmployeeIds?.length ?? 0} employees.`}
        </div>
      )}

      <div className="intake-employee-list">
        {intake.employees.map((employee, index) => {
          const row = previewByEmployee.get(employee.id)
          return (
            <button
              className={employee.id === selectedEmployee?.id ? 'intake-employee-row active' : 'intake-employee-row'}
              type="button"
              key={employee.id}
              onClick={() => setSelectedEmployeeId(employee.id)}
            >
              <span className="intake-row-number">{String(index + 1).padStart(2, '0')}</span>
              <span>
                <strong>{employee.fields.displayName?.value || 'Unnamed employee'}</strong>
                <small>{employee.fields.employeeNo?.value || 'Missing employee number'}</small>
              </span>
              <span className={`intake-status ${row?.status ?? employee.status}`}>
                {row?.status ?? employee.status}
              </span>
            </button>
          )
        })}
      </div>

      {selectedEmployee !== undefined && !committed && (
        <section className="intake-editor">
          <div className="intake-editor-heading">
            <div>
              <span>Selected employee</span>
              <h3>{selectedEmployee.fields.displayName?.value || 'New employee'}</h3>
            </div>
            <Users size={16} />
          </div>
          <div className="intake-fields">
            {FIELD_DEFINITIONS.map((field) => (
              <label key={field.key}>
                <span>
                  {field.label}
                  {'required' in field && field.required && <em>Required</em>}
                </span>
                <input
                  value={formValues[field.key] ?? ''}
                  onChange={(event) => setFormValues((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))}
                />
              </label>
            ))}
          </div>

          {selectedEmployee.issues.length > 0 && (
            <div className="intake-issues">
              {selectedEmployee.issues.map((issue) => (
                <div key={`${issue.code}:${issue.field ?? ''}`}>{issue.message}</div>
              ))}
            </div>
          )}

          <button
            className="secondary-button full-width"
            type="button"
            disabled={saving || busy}
            onClick={() => void saveEmployee()}
          >
            {saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}
            Save employee changes
          </button>
        </section>
      )}

      {preview !== undefined && (
        <section className="intake-preview">
          <div className="intake-preview-heading">
            <div>
              <span>Cloud validation</span>
              <strong>{preview.summary.ready} ready · {preview.summary.blocked} blocked</strong>
            </div>
            <Cloud size={16} />
          </div>
          {preview.rows.filter((row) => row.errors.length > 0).map((row) => (
            <div className="intake-preview-error" key={row.employeeId}>
              <strong>{row.displayName || row.employeeNo || row.employeeId}</strong>
              <span>{row.errors.map((issue) => issue.message).join(' ')}</span>
            </div>
          ))}
        </section>
      )}

      {!committed && (
        <footer className="intake-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={onPreview}
          >
            {busy ? <LoaderCircle className="spin" size={13} /> : <Cloud size={13} />}
            Validate with Cloud
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || committableIds.length === 0}
            onClick={onCommit}
          >
            <Check size={14} />
            Create {committableIds.length} employees
          </button>
        </footer>
      )}
    </aside>
  )
}
