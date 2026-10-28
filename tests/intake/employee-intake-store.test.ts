import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EmployeeIntakeStore } from '../../src/main/intake/employee-intake-store'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'

async function createStores(): Promise<{ sessions: SessionStore; intake: EmployeeIntakeStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'barn-intake-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  return { sessions, intake: new EmployeeIntakeStore(sessions) }
}

describe('EmployeeIntakeStore', () => {
  it('creates, validates and updates employee drafts with revisions', async () => {
    const { sessions, intake } = await createStores()
    const session = sessions.createSession()
    const created = intake.create(session.id, {
      employees: [{
        fields: {
          employeeNo: { value: 'E1001', source: 'document' },
          workEmail: { value: 'wrong@example.com', source: 'document' },
        },
        sourceFiles: ['/tmp/roster.xlsx'],
      }],
    })

    expect(created.status).toBe('blocked')
    expect(created.employees[0]?.issues[0]?.code).toBe('display_name_required')

    const updated = intake.updateEmployee(session.id, {
      employeeId: created.employees[0]!.id,
      fields: {
        displayName: '张三',
        workEmail: 'zhang@example.com',
      },
      expectedRevision: created.revision,
    })

    expect(updated.revision).toBe(2)
    expect(updated.status).toBe('ready')
    expect(updated.employees[0]?.fields.displayName).toMatchObject({
      value: '张三',
      source: 'user',
    })
    expect(intake.get(session.id)).toEqual(updated)
    sessions.close()
  })

  it('blocks duplicate employee numbers inside one intake', async () => {
    const { sessions, intake } = await createStores()
    const session = sessions.createSession()
    const created = intake.create(session.id, {
      employees: [
        { fields: { employeeNo: { value: 'E1001', source: 'document' }, displayName: { value: '张三', source: 'document' } } },
        { fields: { employeeNo: { value: 'E1001', source: 'document' }, displayName: { value: '李四', source: 'document' } } },
      ],
    })

    expect(created.employees[1]?.issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_in_batch',
    }))
    expect(created.status).toBe('blocked')
    sessions.close()
  })
})
