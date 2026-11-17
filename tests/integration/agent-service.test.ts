import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { HostToWorkerMessage, WorkerToHostMessage } from '../../src/shared/agent-protocol'
import type { ModelSelection, SessionLiveEvent } from '../../src/shared/models'
import type { ModelService } from '../../src/main/models/model-service'
import { AesGcmEventCipher } from '../../src/main/session/event-cipher'
import { SessionStore } from '../../src/main/session/session-store'
import { ToolService } from '../../src/main/tools/tool-service'
import type { ShellService } from '../../src/main/sandbox/shell-service'
import { AgentService } from '../../src/main/worker/agent-service'
import type { WorkerTransport } from '../../src/main/worker/worker-supervisor'
import { WorkerSupervisor } from '../../src/main/worker/worker-supervisor'
import { MemoryService } from '../../src/main/memory/memory-service'
import { WorkerRuntime, type WorkerPort } from '../../src/worker/worker-runtime'

class PairedHostTransport implements WorkerTransport {
  private messageListener: ((message: unknown) => void) | undefined
  private exitListener: ((code: number | null) => void) | undefined
  private queue: unknown[] = []
  readonly workerPort: WorkerPort

  constructor() {
    this.workerPort = {
      postMessage: (message: WorkerToHostMessage) => {
        if (this.messageListener === undefined) this.queue.push(message)
        else this.messageListener(message)
      },
      onMessage: (listener) => {
        this.workerMessageListener = listener
        return () => { this.workerMessageListener = undefined }
      },
    }
  }

  private workerMessageListener: ((message: unknown) => void) | undefined

  postMessage(message: HostToWorkerMessage): void {
    this.workerMessageListener?.(message)
  }

  kill(): void {}

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener
    for (const message of this.queue) listener(message)
    this.queue = []
    return () => { this.messageListener = undefined }
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListener = listener
    return () => { this.exitListener = undefined }
  }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
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

function fakeModels(): ModelService {
  const selection: ModelSelection = { providerId: 'openai', modelId: 'test-model' }
  return {
    getSnapshot: async () => ({
      providers: [],
      defaultModel: selection,
      modelSettingsVersion: 1,
    }),
    getModelDescriptor: () => ({
      id: 'test-model',
      name: 'Test Model',
      providerId: 'openai',
      api: 'openai-responses',
      reasoning: false,
      reasoningEfforts: [],
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ['text'],
    }),
    getModelFingerprint: () => 'openai:test-model:test',
    streamSimple: (_selection: ModelSelection, _context: Context, _options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream()
      const partial = assistant('')
      stream.push({ type: 'start', partial })
      stream.push({ type: 'text_start', contentIndex: 0, partial })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello from Barn', partial: assistant('Hello from Barn') })
      stream.push({ type: 'text_end', contentIndex: 0, content: 'Hello from Barn', partial: assistant('Hello from Barn') })
      stream.push({ type: 'done', reason: 'stop', message: assistant('Hello from Barn') })
      return stream
    },
  } as unknown as ModelService
}

describe('AgentService integration', () => {
  it('injects relevant cross-session memory into the next prompt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-agent-memory-'))
    const workspace = join(directory, 'workspace')
    const output = join(directory, 'output')
    const temp = join(directory, 'temp')
    await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])
    const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await sessions.initialize()
    const memory = new MemoryService(sessions.memories)
    memory.setSettings({ enabled: true, useMemories: true })
    memory.save({
      kind: 'preference',
      scope: 'workspace',
      workspacePath: workspace,
      title: 'Summary style',
      content: 'Prefer concise bullet summaries.',
      key: 'summary-style',
    })
    const prompt = vi.fn(async (_sessionId: string, _text: string) => undefined)
    const supervisor = {
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      openSession: vi.fn(async () => undefined),
      prompt,
    } as unknown as WorkerSupervisor
    const tools = new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: vi.fn() } as unknown as ShellService,
      memory,
    })
    const agent = new AgentService(supervisor, fakeModels(), sessions, tools, memory)

    await agent.prompt(randomUUID(), 'Summarize this document', [], workspace)

    expect(prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('<memory_context>'),
    )
    expect(prompt.mock.calls[0]?.[1]).toContain('Prefer concise bullet summaries')
    sessions.close()
  })

  it('injects bounded parent-session context into a side-chat prompt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-agent-parent-context-'))
    const workspace = join(directory, 'workspace')
    const output = join(directory, 'output')
    const temp = join(directory, 'temp')
    await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])

    const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await sessions.initialize()
    const parent = sessions.createSession('Parent conversation')
    sessions.append(parent.id, [{
      type: 'agent.message',
      data: {
        message: {
          role: 'user',
          content: 'The parent-only launch code is 4721.',
          timestamp: Date.now(),
        },
      },
    }])
    const child = sessions.ensureSession(randomUUID(), 'Side chat', undefined, parent.id)
    const prompt = vi.fn(async (_sessionId: string, _text: string) => undefined)
    const supervisor = {
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      openSession: vi.fn(async () => undefined),
      prompt,
    } as unknown as WorkerSupervisor
    const tools = new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: vi.fn() } as unknown as ShellService,
    })
    const agent = new AgentService(supervisor, fakeModels(), sessions, tools)

    await agent.prompt(child.id, 'What is the launch code?')

    expect(prompt).toHaveBeenCalledWith(
      child.id,
      expect.stringContaining('The parent-only launch code is 4721.'),
    )
    expect(prompt.mock.calls[0]?.[1]).toContain('<parent_session_context>')
    sessions.close()
  })

  it('honors cancellation while the Worker session is still opening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-agent-cancel-start-'))
    const workspace = join(directory, 'workspace')
    const output = join(directory, 'output')
    const temp = join(directory, 'temp')
    await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])

    const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await sessions.initialize()
    let releaseOpen: (() => void) | undefined
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })
    const prompt = vi.fn(async (_sessionId: string, _text: string) => undefined)
    const cancel = vi.fn(async (_sessionId: string) => undefined)
    const supervisor = {
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      openSession: vi.fn(async () => openGate),
      prompt,
      cancel,
    } as unknown as WorkerSupervisor
    const tools = new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: vi.fn() } as unknown as ShellService,
    })
    const agent = new AgentService(supervisor, fakeModels(), sessions, tools)
    const statuses: string[] = []
    agent.onLiveEvent((event) => {
      if (event.type === 'run.status') statuses.push(event.status)
    })

    const sessionId = randomUUID()
    const starting = agent.prompt(sessionId, 'Hello')
    await vi.waitFor(() => expect(supervisor.openSession).toHaveBeenCalled())
    await agent.cancel(sessionId)
    releaseOpen?.()
    const summary = await starting

    expect(prompt).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(statuses).toEqual(['cancelled'])
    expect(summary.status).toBe('idle')
    sessions.close()
  })

  it('forwards a Worker tool cancellation to the running Host tool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-agent-cancel-tool-'))
    const workspace = join(directory, 'workspace')
    const output = join(directory, 'output')
    const temp = join(directory, 'temp')
    await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])

    const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await sessions.initialize()
    let workerMessage: ((message: WorkerToHostMessage) => void) | undefined
    const supervisor = {
      onMessage: (listener: (message: WorkerToHostMessage) => void) => {
        workerMessage = listener
        return () => { workerMessage = undefined }
      },
      onStatus: () => () => undefined,
      post: vi.fn(),
    } as unknown as WorkerSupervisor
    const shellRun = vi.fn((request: { command: string; cwd: string; signal?: AbortSignal }) =>
      new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => resolve({
          command: request.command,
          cwd: request.cwd,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: true,
          sandbox: { backend: 'test', mode: 'workspace-write' },
        }), { once: true })
      }))
    const tools = new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: shellRun } as unknown as ShellService,
    })
    const agent = new AgentService(supervisor, fakeModels(), sessions, tools)
    expect(agent).toBeDefined()
    const sessionId = sessions.createSession('Tool cancellation', randomUUID()).id

    workerMessage?.({
      type: 'tool.execute',
      requestId: 'worker:request:tool-1',
      sessionId,
      toolName: 'shell',
      args: { command: 'sleep 10' },
    })
    await vi.waitFor(() => expect(shellRun).toHaveBeenCalled())
    const signal = shellRun.mock.calls[0]?.[0].signal
    expect(signal?.aborted).toBe(false)

    workerMessage?.({ type: 'tool.cancel', requestId: 'worker:request:tool-1' })

    expect(signal?.aborted).toBe(true)
    expect(supervisor.post).not.toHaveBeenCalled()
    sessions.close()
  })

  it('runs a prompt through the Worker and persists the conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-agent-service-'))
    const workspace = join(directory, 'workspace')
    const output = join(directory, 'output')
    const temp = join(directory, 'temp')
    await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])

    const sessions = new SessionStore(join(directory, 'sessions.db'), new AesGcmEventCipher(randomBytes(32)))
    await sessions.initialize()
    const sessionId = randomUUID()
    const transport = new PairedHostTransport()
    const runtime = new WorkerRuntime(transport.workerPort)
    const supervisor = new WorkerSupervisor({
      createTransport: () => transport,
      autoRestart: false,
    })
    const tools = new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: vi.fn() } as unknown as ShellService,
    })
    const agent = new AgentService(supervisor, fakeModels(), sessions, tools)
    const statuses: string[] = []
    const liveEvents: SessionLiveEvent[] = []
    agent.onLiveEvent((event) => {
      liveEvents.push(event)
      if (event.type === 'run.status') statuses.push(event.status)
    })

    const starting = agent.start()
    await vi.waitFor(() => expect(transport.workerPort).toBeDefined())
    runtime.start()
    await starting
    await agent.prompt(sessionId, 'Hello')

    await vi.waitFor(() => expect(statuses).toContain('idle'))
    const firstDelta = liveEvents.findIndex((event) => event.type === 'assistant.delta')
    const idle = liveEvents.findIndex((event) => event.type === 'run.status' && event.status === 'idle')
    expect(firstDelta).toBeGreaterThanOrEqual(0)
    expect(idle).toBeGreaterThan(firstDelta)
    expect(liveEvents.slice(firstDelta, idle).filter((event) => event.type === 'session.updated')).toEqual([])
    expect(liveEvents.filter((event) => event.type === 'session.updated')).toHaveLength(2)
    const events = agent.getEvents(sessionId)
    expect(events.map((event) => event.type)).toEqual(['agent.message', 'agent.message'])
    expect(events[1]?.data).toMatchObject({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Barn' }],
      },
    })

    await agent.stop()
    sessions.close()
  })
})
