import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { LocalSourceService } from '../../src/main/sources/local-source-service'
import { TaskService } from '../../src/main/tasks/task-service'

async function harness(now?: () => Date) {
  const directory = await mkdtemp(join(tmpdir(), 'barn-source-service-'))
  const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await sessions.initialize()
  const tasks = new TaskService(sessions.tasks)
  const sources = new LocalSourceService(sessions.localSources, tasks, {
    pollIntervalMs: 0,
    ...(now === undefined ? {} : { now }),
  })
  sources.start()
  return { directory, sessions, tasks, sources }
}

describe('LocalSourceService', () => {
  it('baselines a watched folder, then proposes a task once for a changed file', async () => {
    const h = await harness()
    const watched = join(h.directory, 'watched')
    await mkdir(watched)
    const file = join(watched, 'notes.txt')
    await writeFile(file, 'first')
    h.sources.create({
      name: 'Watched notes',
      config: { kind: 'file-watch', path: watched, recursive: false, maxDepth: 1 },
    })
    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(file, 'second version')
    await h.sources.pollNow()
    const proposed = h.tasks.list()
    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({
      status: 'proposed',
      origin: 'automation',
      title: 'Review changed file: notes.txt',
    })

    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    h.sources.stop()
    h.sessions.close()
  })

  it('creates one proposed task when a schedule becomes due and advances the cursor', async () => {
    let now = new Date('2026-11-14T00:00:00.000Z')
    const h = await harness(() => now)
    const source = h.sources.create({
      name: 'Daily review',
      config: {
        kind: 'schedule',
        intervalMinutes: 60,
        title: 'Review today’s priorities',
        prompt: 'Review the workspace and suggest priorities.',
      },
    })
    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(0)

    now = new Date('2026-11-14T01:00:01.000Z')
    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    expect(h.tasks.list()[0]).toMatchObject({
      status: 'proposed',
      title: 'Review today’s priorities',
    })
    expect(h.sessions.localSources.state(source.id).nextRunAt).toBe('2026-11-14T02:00:00.000Z')

    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    h.sources.stop()
    h.sessions.close()
  })

  it('queues tasks in active mode instead of proposing them', async () => {
    const h = await harness()
    h.sources.setAutomationSettings({ mode: 'active', maxPendingSuggestions: 20, suggestionCooldownMinutes: 0 })
    const source = h.sources.create({
      name: 'Active schedule',
      config: { kind: 'schedule', intervalMinutes: 1, title: 'Active review', prompt: 'Review now.' },
    })
    h.sessions.localSources.saveState(source.id, { nextRunAt: '2000-01-01T00:00:00.000Z' })
    await h.sources.pollNow()
    expect(h.tasks.list()[0]).toMatchObject({ status: 'queued', title: 'Active review' })
    h.sources.stop()
    h.sessions.close()
  })

  it('applies the pending suggestion limit and per-source cooldown', async () => {
    const h = await harness()
    const watched = join(h.directory, 'limited')
    await mkdir(watched)
    await writeFile(join(watched, 'a.txt'), 'a')
    await writeFile(join(watched, 'b.txt'), 'b')
    h.sources.create({
      name: 'Limited watch',
      config: { kind: 'file-watch', path: watched, recursive: false, maxDepth: 1 },
    })
    h.sources.setAutomationSettings({ mode: 'observe', maxPendingSuggestions: 20, suggestionCooldownMinutes: 60 })
    await h.sources.pollNow()
    await writeFile(join(watched, 'a.txt'), 'a changed')
    await writeFile(join(watched, 'b.txt'), 'b changed')
    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(1)

    h.sources.setAutomationSettings({ mode: 'observe', maxPendingSuggestions: 1, suggestionCooldownMinutes: 0 })
    await writeFile(join(watched, 'a.txt'), 'a changed again')
    await writeFile(join(watched, 'b.txt'), 'b changed again')
    await h.sources.pollNow()
    expect(h.tasks.list()).toHaveLength(1)
    h.sources.stop()
    h.sessions.close()
  })

  it('records source failures without stopping other sources', async () => {
    const h = await harness()
    const broken = h.sources.create({
      name: 'Missing folder',
      config: { kind: 'file-watch', path: join(h.directory, 'missing'), recursive: false, maxDepth: 1 },
    })
    h.sources.create({
      name: 'Scheduled review',
      config: { kind: 'schedule', intervalMinutes: 30, title: 'Review', prompt: 'Review.' },
    })
    await h.sources.pollNow()
    expect(h.sources.list().find((source) => source.id === broken.id)?.lastError).toContain('ENOENT')
    h.sources.stop()
    h.sessions.close()
  })
})
