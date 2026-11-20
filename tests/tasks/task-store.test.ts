import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'

async function openStore(directory: string, key = randomBytes(32)): Promise<SessionStore> {
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(key))
  await store.initialize()
  return store
}

describe('TaskStore', () => {
  it('persists tasks independently from the Session that executes them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const session = store.createSession('Quarterly report')
    const routerSession = store.createSession('Quarterly report Router', undefined, undefined, session.id)
    const task = store.tasks.create({
      title: 'Prepare the quarterly report',
      origin: 'user',
      sessionId: session.id,
      prompt: 'Summarize the attached figures and prepare the report.',
      visiblePrompt: 'Summarize the figures.',
    }, '11111111-1111-4111-8111-111111111111')
    store.tasks.assignRouterSession(task.id, routerSession.id)
    store.close()

    const reopened = await openStore(directory, key)
    expect(reopened.tasks.get(task.id)).toEqual(expect.objectContaining({
      id: task.id,
      title: 'Prepare the quarterly report',
      status: 'queued',
      origin: 'user',
      sessionId: session.id,
      routerSessionId: routerSession.id,
      prompt: 'Summarize the attached figures and prepare the report.',
      visiblePrompt: 'Summarize the figures.',
    }))
    reopened.close()
  })

  it('persists execution attachments and the selected working directory with the task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const task = store.tasks.create({
      title: 'Inspect a project folder',
      origin: 'user',
      prompt: 'Inspect the attached materials.',
      workingDirectory: '/tmp/selected-project',
      attachments: [{
        name: 'brief.pdf',
        path: '/tmp/brief.pdf',
        size: 42,
        kind: 'file',
      }],
    })
    store.close()

    const reopened = await openStore(directory, key)
    expect(reopened.tasks.get(task.id)).toMatchObject({
      workingDirectory: '/tmp/selected-project',
      attachments: [{ name: 'brief.pdf', path: '/tmp/brief.pdf', size: 42, kind: 'file' }],
    })
    reopened.close()
  })

  it('encrypts task instructions at rest and fails closed with another key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const path = join(directory, 'sessions.db')
    const key = randomBytes(32)
    const store = await openStore(directory, key)
    const task = store.tasks.create({
      title: 'Private task',
      origin: 'user',
      prompt: 'Do not expose this instruction in plain text.',
    })
    store.close()

    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT prompt_ciphertext, prompt_nonce, prompt_tag FROM tasks WHERE id = ?').get(task.id) as {
      prompt_ciphertext: Uint8Array
      prompt_nonce: Uint8Array
      prompt_tag: Uint8Array
    }
    expect(Buffer.from(row.prompt_ciphertext).toString('utf8')).not.toContain('Do not expose')
    raw.close()

    const wrongKey = await openStore(directory, randomBytes(32))
    expect(() => wrongKey.tasks.get(task.id)).toThrow()
    wrongKey.close()
  })

  it('migrates task tables created before prompt encryption existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const path = join(directory, 'sessions.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, waiting_reason TEXT, detail TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      INSERT INTO tasks (id, title, status, origin, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'Legacy task', 'queued', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `)
    raw.close()

    const store = await openStore(directory)
    expect(store.tasks.get('11111111-1111-4111-8111-111111111111')).toMatchObject({
      title: 'Legacy task',
      status: 'queued',
    })
    store.close()
  })

  it('enforces the task state machine and records lifecycle timestamps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Analyze feedback', origin: 'user' })

    const running = store.tasks.updateStatus(task.id, { status: 'running', detail: 'Reading source files' })
    expect(running.startedAt).toBeDefined()
    expect(running.finishedAt).toBeUndefined()

    const waiting = store.tasks.updateStatus(task.id, {
      status: 'waiting',
      waitingReason: 'approval',
      detail: 'Approve the generated summary',
    })
    expect(waiting).toMatchObject({
      status: 'waiting',
      waitingReason: 'approval',
      detail: 'Approve the generated summary',
    })

    const completed = store.tasks.updateStatus(task.id, { status: 'completed' })
    expect(completed.status).toBe('completed')
    expect(completed.finishedAt).toBeDefined()
    expect(completed.waitingReason).toBeUndefined()
    expect(() => store.tasks.updateStatus(task.id, { status: 'running' })).toThrow('Invalid task transition')
    store.close()
  })

  it('requires a reason only while a task is waiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Draft follow-up', origin: 'automation' })

    expect(() => store.tasks.updateStatus(task.id, { status: 'waiting' })).toThrow('waiting reason')
    store.tasks.updateStatus(task.id, { status: 'waiting', waitingReason: 'input' })
    expect(() => store.tasks.updateStatus(task.id, {
      status: 'queued',
      waitingReason: 'input',
    })).toThrow('Only a waiting task')
    store.close()
  })

  it('links a waiting task to a durable approval and clears it when resolved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Needs approval', origin: 'user', prompt: 'Send the draft.' })

    const waiting = store.tasks.requestApproval(
      task.id,
      '11111111-1111-4111-8111-111111111111',
      'Send the prepared draft.',
    )
    expect(waiting).toMatchObject({
      status: 'waiting',
      waitingReason: 'approval',
      approvalId: '11111111-1111-4111-8111-111111111111',
    })
    expect(store.tasks.updateStatus(task.id, { status: 'queued' }).approvalId).toBeUndefined()
    store.close()
  })

  it('updates instructions before a task runs and rejects edits during execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Needs instructions', origin: 'user' })
    store.tasks.updateStatus(task.id, { status: 'waiting', waitingReason: 'input' })

    expect(store.tasks.updatePrompt(task.id, 'Summarize the notes.').prompt).toBe('Summarize the notes.')
    store.tasks.updateStatus(task.id, { status: 'queued' })
    store.tasks.updateStatus(task.id, { status: 'running' })
    expect(() => store.tasks.updatePrompt(task.id, 'Different instructions.')).toThrow('cannot change')
    store.close()
  })

  it('links tasks only to existing Sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const task = store.tasks.create({ title: 'Create a presentation', origin: 'user' })
    const session = store.createSession('Presentation')

    expect(() => store.tasks.assignSession(task.id, '11111111-1111-4111-8111-111111111111')).toThrow('Unknown session')
    expect(store.tasks.assignSession(task.id, session.id).sessionId).toBe(session.id)
    expect(store.tasks.assignSession(task.id, null).sessionId).toBeUndefined()
    store.close()
  })

  it('returns interrupted running work to the queue on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const session = store.createSession('Invoice summary')
    const interrupted = store.tasks.create({
      title: 'Summarize invoices',
      origin: 'automation',
      sessionId: session.id,
      prompt: 'Summarize the invoices.',
    })
    const untouched = store.tasks.create({ title: 'Waiting on a decision', origin: 'user' })
    store.tasks.updateStatus(interrupted.id, { status: 'running' })
    store.tasks.updateStatus(untouched.id, { status: 'waiting', waitingReason: 'input' })

    expect(store.tasks.recoverInterruptedTasks()).toBe(1)
    const recovered = store.tasks.get(interrupted.id)
    expect(recovered).toMatchObject({
      status: 'queued',
      detail: 'Recovered after restart',
    })
    expect(recovered.sessionId).toBeUndefined()
    expect(store.tasks.get(untouched.id).status).toBe('waiting')
    store.close()
  })

  it('orders tasks waiting for the user before other active and finished work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-task-store-'))
    const store = await openStore(directory)
    const finished = store.tasks.create({ title: 'Finished', origin: 'user' })
    store.tasks.updateStatus(finished.id, { status: 'running' })
    store.tasks.updateStatus(finished.id, { status: 'completed' })
    const proposed = store.tasks.create({ title: 'Proposed', origin: 'automation', status: 'proposed' })
    const waiting = store.tasks.create({ title: 'Waiting', origin: 'user' })
    store.tasks.updateStatus(waiting.id, { status: 'waiting', waitingReason: 'approval' })
    const queued = store.tasks.create({ title: 'Queued', origin: 'user' })

    expect(store.tasks.list().map((task) => task.id)).toEqual([
      waiting.id,
      queued.id,
      proposed.id,
      finished.id,
    ])
    store.close()
  })
})
