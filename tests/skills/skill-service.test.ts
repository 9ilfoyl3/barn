import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalSkillScanner } from '../../src/main/skills/local-skill-scanner'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { SkillService } from '../../src/main/skills/skill-service'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-skills-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  return { directory, sessions, skills: new SkillService(sessions.skills) }
}

async function localHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'barn-local-skills-'))
  const home = join(directory, 'home')
  const skillDirectory = join(home, '.agents', 'skills', 'weekly-review')
  await mkdir(join(skillDirectory, 'references'), { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: Weekly review',
    'description: Turn a week of work into a concise review.',
    '---',
    '',
    '# Weekly review',
    '',
    'List outcomes and next steps.',
  ].join('\n'))
  await writeFile(join(skillDirectory, 'references', 'checklist.md'), '# Checklist\n\n- Outcomes\n- Risks')
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const scanner = new LocalSkillScanner({
    homeDirectory: home,
    includeDefaultRoots: true,
    includePluginRoots: false,
    scanTtlMs: 0,
  })
  const skills = new SkillService(sessions.skills, scanner)
  await skills.initialize()
  return { directory, home, sessions, scanner, skills }
}

describe('SkillService', () => {
  it('lists built-in system skills alongside custom skills', async () => {
    const h = await harness()
    const created = h.skills.create({
      name: 'Team weekly review',
      description: 'Summarize the week.',
      instructions: '# Team weekly review\n\nList outcomes and next steps.',
    })

    expect(h.skills.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'system-meeting-notes', source: 'system', provider: 'barn', editable: false }),
      expect.objectContaining({ id: created.id, source: 'custom', enabled: true, editable: true }),
    ]))
    expect((await h.skills.get(created.id)).instructions).toContain('List outcomes and next steps')
    h.sessions.close()
  })

  it('updates, disables, re-enables, and removes custom skills', async () => {
    const h = await harness()
    const created = h.skills.create({ name: 'Release notes', description: '', instructions: '# Draft' })
    const updated = await h.skills.update(created.id, {
      description: 'Draft release notes.',
      instructions: '# Release notes\n\nUse the accepted changes only.',
    })
    expect(updated).toMatchObject({ description: 'Draft release notes.', enabled: true })

    expect(await h.skills.setEnabled(created.id, false)).toMatchObject({ enabled: false })
    expect((await h.skills.enabledDetails()).some((skill) => skill.id === created.id)).toBe(false)
    expect(await h.skills.setEnabled(created.id, true)).toMatchObject({ enabled: true })

    h.skills.remove(created.id)
    expect(h.skills.list().some((skill) => skill.id === created.id)).toBe(false)
    h.sessions.close()
  })

  it('keeps system skills read-only', async () => {
    const h = await harness()
    await expect(h.skills.update('system-meeting-notes', { name: 'Changed' })).rejects.toThrow('read-only')
    expect(() => h.skills.remove('system-meeting-notes')).toThrow('cannot be removed')
    h.sessions.close()
  })

  it('discovers local packages, reads resources, and persists enablement', async () => {
    const h = await localHarness()
    const local = h.skills.list().find((skill) => skill.source === 'local')

    expect(local).toMatchObject({
      name: 'Weekly review',
      description: 'Turn a week of work into a concise review.',
      provider: 'agents',
      providerLabel: 'Agents',
      editable: false,
      enabled: true,
      fileCount: 1,
    })
    expect(local?.location).toContain(join('.agents', 'skills', 'weekly-review', 'SKILL.md'))

    const detail = await h.skills.get(local!.id)
    expect(detail.instructions).toContain('List outcomes and next steps.')
    expect(detail.files).toEqual([expect.objectContaining({ path: 'references/checklist.md', mediaType: 'text/markdown' })])
    expect((await h.skills.readFile(local!.id, 'references/checklist.md')).text).toContain('- Outcomes')
    await expect(h.skills.readFile(local!.id, '../outside.md')).rejects.toThrow('Invalid skill file path')
    await expect(h.skills.update(local!.id, { name: 'Changed' })).rejects.toThrow('read-only')
    expect(() => h.skills.remove(local!.id)).toThrow('cannot be removed')

    const revisionBeforeDisable = h.skills.getRevision()
    expect(await h.skills.setEnabled(local!.id, false)).toMatchObject({ enabled: false })
    expect(h.skills.getRevision()).not.toBe(revisionBeforeDisable)
    expect(h.skills.agentContext()).not.toContain('Weekly review')

    const restarted = new SkillService(h.sessions.skills, new LocalSkillScanner({
      homeDirectory: h.home,
      includePluginRoots: false,
      scanTtlMs: 0,
    }))
    await restarted.initialize()
    expect(restarted.list().find((skill) => skill.id === local!.id)?.enabled).toBe(false)
    h.sessions.close()
  })

  it('includes enabled skills in the Agent discovery context', async () => {
    const h = await localHarness()
    const context = h.skills.agentContext()
    expect(context).toContain('<available_skills>')
    expect(context).toContain('Weekly review (local:agents:')
    expect(context).toContain('user-controlled discovery metadata')
    h.sessions.close()
  })
})
