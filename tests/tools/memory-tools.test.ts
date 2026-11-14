import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryService } from '../../src/main/memory/memory-service'
import type { ShellService } from '../../src/main/sandbox/shell-service'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { ToolService } from '../../src/main/tools/tool-service'

async function createMemoryTools(): Promise<{
  service: ToolService
  store: SessionStore
  memory: MemoryService
  workspace: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'barn-memory-tools-'))
  const workspace = join(root, 'workspace')
  const output = join(root, 'output')
  const temp = join(root, 'temp')
  await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])
  const store = new SessionStore(join(root, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await store.initialize()
  const memory = new MemoryService(store.memories)
  const service = new ToolService({
    workspaceRoot: workspace,
    outputRoot: output,
    privateTempRoot: temp,
    shell: { run: vi.fn() } as unknown as ShellService,
    memory,
  })
  return { service, store, memory, workspace }
}

describe('memory tools', () => {
  it('saves, searches, and forgets scoped memory', async () => {
    const { service, store, memory, workspace } = await createMemoryTools()
    memory.setSettings({ enabled: true })

    const saved = await service.execute('memory_save', {
      kind: 'procedure',
      scope: 'workspace',
      title: 'Release checks',
      content: 'Run lint, tests, and packaging before release.',
      tags: ['release'],
      key: 'release-checks',
      pinned: true,
    })
    expect(saved).toMatchObject({ details: { version: 1 } })
    const id = (saved.details as { id: string }).id

    const search = await service.execute('memory_search', {
      query: 'release packaging',
      scope: 'workspace',
    }, { workingDirectory: workspace })
    expect(search).toMatchObject({ details: { count: 1, ids: [id] } })
    expect(search.content[0]).toMatchObject({ text: expect.stringContaining('Release checks') })

    await service.execute('memory_forget', { id })
    const empty = await service.execute('memory_search', { query: 'release' }, { workingDirectory: workspace })
    expect(empty).toMatchObject({ details: { count: 0 } })
    store.close()
  })

  it('fails closed when memory is disabled or content contains credentials', async () => {
    const { service, store, memory } = await createMemoryTools()

    await expect(service.execute('memory_save', {
      kind: 'fact',
      title: 'Disabled',
      content: 'Should fail.',
    })).resolves.toMatchObject({ isError: true })

    memory.setSettings({ enabled: true })
    const result = await service.execute('memory_save', {
      kind: 'fact',
      title: 'Unsafe',
      content: 'API_KEY=sk-123456789012345678901234',
    })
    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('sensitive') })
    store.close()
  })
})
