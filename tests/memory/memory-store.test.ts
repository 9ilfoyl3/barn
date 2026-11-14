import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { MemoryService } from '../../src/main/memory/memory-service'

describe('MemoryStore', () => {
  it('persists encrypted global memory across sessions and updates by key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-memory-store-'))
    const path = join(directory, 'sessions.db')
    const cipher = new AesGcmEventCipher(randomBytes(32))
    const store = new SessionStore(path, cipher)
    await store.initialize()

    const first = store.memories.save({
      kind: 'preference',
      scope: 'global',
      title: 'Package manager',
      content: 'Use pnpm for this user.',
      key: 'package-manager',
      tags: ['tooling'],
      sourceSessionId: 'session-one',
    })
    const updated = store.memories.save({
      kind: 'preference',
      scope: 'global',
      title: 'Package manager',
      content: 'Use pnpm 10 for this user.',
      key: 'package-manager',
      tags: ['tooling'],
      sourceSessionId: 'session-two',
    })

    expect(updated.id).toBe(first.id)
    expect(updated.version).toBe(2)
    expect(updated.content).toBe('Use pnpm 10 for this user.')
    expect(updated.sourceSessionIds).toEqual(['session-one', 'session-two'])
    expect(store.memories.list()).toHaveLength(1)

    const disk = new DatabaseSync(path, { readOnly: true })
    const row = disk.prepare('SELECT payload_ciphertext FROM memory_entries LIMIT 1').get() as { payload_ciphertext: Uint8Array }
    expect(Buffer.from(row.payload_ciphertext).toString('utf8')).not.toContain('pnpm 10')
    disk.close()
    store.close()
  })

  it('isolates workspace memory and retrieves relevant scoped entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-memory-store-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const workspaceA = join(directory, 'project-a')
    const workspaceB = join(directory, 'project-b')

    store.memories.save({
      kind: 'procedure',
      scope: 'workspace',
      workspacePath: workspaceA,
      title: 'Test command',
      content: 'Run pnpm test before shipping.',
      key: 'test-command',
    })
    store.memories.save({
      kind: 'procedure',
      scope: 'workspace',
      workspacePath: workspaceB,
      title: 'Other test command',
      content: 'Run go test ./... before shipping.',
      key: 'test-command',
    })

    expect(store.memories.search({ query: 'shipping test', workspacePath: workspaceA })).toMatchObject([
      { title: 'Test command', scope: 'workspace' },
    ])
    expect(store.memories.search({ query: 'shipping test', workspacePath: workspaceB })).toMatchObject([
      { title: 'Other test command', scope: 'workspace' },
    ])
    store.close()
  })

  it('derives stable keyed fingerprints without storing the source value', () => {
    const cipher = new AesGcmEventCipher(randomBytes(32))
    const first = cipher.fingerprint('workspace:/tmp/example')
    expect(first).toBe(cipher.fingerprint('workspace:/tmp/example'))
    expect(first).not.toBe(cipher.fingerprint('workspace:/tmp/other'))
    expect(first).not.toContain('/tmp/example')
  })

  it('rejects secrets and supports deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-memory-store-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()

    expect(() => store.memories.save({
      kind: 'fact',
      scope: 'global',
      title: 'Unsafe',
      content: 'OPENAI_API_KEY=sk-123456789012345678901234',
      key: 'unsafe',
    })).toThrow('sensitive')

    const memory = store.memories.save({
      kind: 'fact',
      scope: 'global',
      title: 'Safe',
      content: 'The user prefers concise summaries.',
      key: 'concise',
    })
    store.memories.delete(memory.id)
    expect(store.memories.list()).toEqual([])
    store.close()
  })
})

describe('MemoryService', () => {
  it('enforces settings and builds a bounded prompt context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-memory-service-'))
    const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await store.initialize()
    const service = new MemoryService(store.memories)

    expect(() => service.save({
      kind: 'preference',
      scope: 'global',
      title: 'Language',
      content: 'Prefer Chinese responses.',
      key: 'language',
    })).toThrow('disabled')

    service.setSettings({ enabled: true, useMemories: true, generateMemories: true })
    service.save({
      kind: 'preference',
      scope: 'global',
      title: 'Language',
      content: 'Prefer Chinese responses.',
      key: 'language',
      pinned: true,
    })
    const context = service.contextForPrompt('Please summarize this document', directory)
    expect(context).toContain('memory_context')
    expect(context).toContain('Prefer Chinese responses')
    expect(context.length).toBeLessThan(7_000)
    store.close()
  })
})
