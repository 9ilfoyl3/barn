import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '../../src/shared/models'
import type { ModelService } from '../../src/main/models/model-service'
import { MemoryExtractionService } from '../../src/main/memory/memory-extraction'
import { MemoryService } from '../../src/main/memory/memory-service'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'

function fakeModel(response: string): ModelService {
  const selection: ModelSelection = { providerId: 'openai', modelId: 'memory-model' }
  return {
    getSnapshot: async () => ({ providers: [], defaultModel: selection, modelSettingsVersion: 1 }),
    getModelDescriptor: () => ({
      id: 'memory-model',
      name: 'Memory Model',
      providerId: 'openai',
      api: 'openai-responses',
      reasoning: false,
      reasoningEfforts: [],
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ['text'],
    }),
    streamSimple: (_selection: ModelSelection, _context: Context, _options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream()
      const partial = assistant('')
      stream.push({ type: 'start', partial })
      stream.push({ type: 'text_start', contentIndex: 0, partial })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: response, partial: assistant(response) })
      stream.push({ type: 'text_end', contentIndex: 0, content: response, partial: assistant(response) })
      stream.push({ type: 'done', reason: 'stop', message: assistant(response) })
      return stream
    },
  } as unknown as ModelService
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'memory-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

async function setup(response: string): Promise<{
  store: SessionStore
  sessionId: string
  workspace: string
  model: ModelService
  service: MemoryExtractionService
}> {
  const directory = await mkdtemp(join(tmpdir(), 'barn-memory-extraction-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const store = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
  await store.initialize()
  store.memories.setSettings({ enabled: true, generateMemories: true, useMemories: true, idleMinutes: 15 })
  const session = store.createSession('Project work', randomUUID(), workspace)
  store.append(session.id, [{
    type: 'agent.message',
    data: { message: { role: 'user', content: 'For this project, always use pnpm and run tests before a PR.' } },
  }, {
    type: 'agent.message',
    data: { message: { role: 'assistant', content: 'Understood.' } },
  }])
  store.updateStatus(session.id, 'idle')
  const model = fakeModel(response)
  return {
    store,
    sessionId: session.id,
    workspace,
    model,
    service: new MemoryExtractionService(store, model),
  }
}

describe('MemoryExtractionService', () => {
  it('extracts stable memory from an idle Session once and records provenance', async () => {
    const response = JSON.stringify({
      memories: [{
        kind: 'procedure',
        scope: 'workspace',
        title: 'Project workflow',
        content: 'Use pnpm and run tests before opening a PR.',
        tags: ['workflow', 'testing'],
        key: 'project-workflow',
        confidence: 0.94,
      }],
    })
    const { store, sessionId, model, service } = await setup(response)
    const spy = vi.spyOn(model, 'streamSimple')

    await service.runOnce(new Date(Date.now() + 60 * 60 * 1_000))

    expect(store.memories.list()).toEqual([])
    const candidates = store.memories.listCandidates()
    expect(candidates).toMatchObject([{
      scope: 'workspace',
      kind: 'procedure',
      title: 'Project workflow',
      sourceSessionIds: [sessionId],
      sourceAuthority: 'inferred',
      status: 'candidate',
    }])
    expect(candidates[0]?.sourceRefs).toEqual(expect.arrayContaining([`session:${sessionId}:seq:2`]))
    const confirmed = store.memories.confirm(candidates[0]!.id)
    expect(confirmed).toMatchObject({ status: 'active', sourceAuthority: 'inferred' })
    expect(confirmed.lastConfirmedAt).toEqual(expect.any(String))
    await service.runOnce(new Date(Date.now() + 2 * 60 * 60 * 1_000))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.memories.extractionState(sessionId)).toMatchObject({ lastProcessedSeq: 2, attempts: 0 })
    expect(store.memories.list()).toHaveLength(1)
    store.close()
  })

  it('records extraction failure and backs off before retrying', async () => {
    const { store, sessionId, model, service } = await setup('{"memories": [')
    const spy = vi.spyOn(model, 'streamSimple')
    const now = new Date(Date.now() + 60 * 60 * 1_000)

    await service.runOnce(now)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.memories.extractionState(sessionId)).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('valid JSON'),
    })

    await service.runOnce(new Date(now.getTime() + 60 * 60 * 1_000))
    expect(spy).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('respects session generation controls', async () => {
    const response = JSON.stringify({ memories: [{ kind: 'preference', title: 'Style', content: 'Be concise.', key: 'style' }] })
    const { store, sessionId, service, model } = await setup(response)
    store.memories.setSessionControls(sessionId, { generateMemories: false })
    const stream = vi.spyOn(model, 'streamSimple')

    await service.runOnce(new Date(Date.now() + 60 * 60 * 1_000))

    expect(stream).not.toHaveBeenCalled()
    expect(store.memories.list()).toEqual([])
    store.close()
  })

  it('does not inject memory into a Session that opted out', async () => {
    const { store, sessionId, workspace } = await setup(JSON.stringify({ memories: [] }))
    const memory = new MemoryService(store.memories)
    memory.save({
      kind: 'preference',
      scope: 'workspace',
      workspacePath: workspace,
      title: 'Summary format',
      content: 'Use bullet summaries.',
      key: 'summary-format',
      pinned: true,
    })
    memory.setSessionControls(sessionId, { useMemories: false })

    expect(memory.contextForPrompt('Summarize this', workspace, sessionId)).toBe('')
    store.close()
  })
})
