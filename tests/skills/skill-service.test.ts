import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { SkillService } from '../../src/main/skills/skill-service'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-skills-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  return { sessions, skills: new SkillService(sessions.skills) }
}

describe('SkillService', () => {
  it('lists built-in system skills alongside custom skills', async () => {
    const h = await harness()
    const created = h.skills.create({
      name: 'Weekly review',
      description: 'Summarize the week.',
      instructions: '# Weekly review\n\nList outcomes and next steps.',
    })

    expect(h.skills.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'system-meeting-notes', source: 'system' }),
      expect.objectContaining({ id: created.id, source: 'custom', enabled: true }),
    ]))
    expect(h.skills.get(created.id).instructions).toContain('List outcomes and next steps')
    h.sessions.close()
  })

  it('updates, disables, re-enables, and removes custom skills', async () => {
    const h = await harness()
    const created = h.skills.create({ name: 'Release notes', description: '', instructions: '# Draft' })
    const updated = h.skills.update(created.id, {
      description: 'Draft release notes.',
      instructions: '# Release notes\n\nUse the accepted changes only.',
    })
    expect(updated).toMatchObject({ description: 'Draft release notes.', enabled: true })

    expect(h.skills.setEnabled(created.id, false)).toMatchObject({ enabled: false })
    expect(h.skills.enabledDetails().some((skill) => skill.id === created.id)).toBe(false)
    expect(h.skills.setEnabled(created.id, true)).toMatchObject({ enabled: true })

    h.skills.remove(created.id)
    expect(h.skills.list().some((skill) => skill.id === created.id)).toBe(false)
    h.sessions.close()
  })

  it('keeps system skills read-only', async () => {
    const h = await harness()
    expect(() => h.skills.update('system-meeting-notes', { name: 'Changed' })).toThrow('read-only')
    expect(() => h.skills.remove('system-meeting-notes')).toThrow('cannot be removed')
    h.sessions.close()
  })
})
