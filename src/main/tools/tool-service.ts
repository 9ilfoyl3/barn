import { isUtf8 } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolExecutionResult } from '../../shared/agent-protocol'
import type { RouterToolDescriptor } from '../../shared/router-tools'
import type { ShellService } from '../sandbox/shell-service'
import type { BrowserToolService } from '../browser/browser-tools'
import { resolveSandboxPolicy } from '../sandbox/policy'
import {
  findFilesInput,
  findWorkspaceFiles,
  listDirInput,
  listWorkspaceDirectory,
  searchFilesInput,
  searchWorkspaceContents,
} from './workspace-search'
import { isDeniedPath } from './workspace-path-policy'
import type { MemoryService } from '../memory/memory-service'
import type { MemoryUpdateInput } from '../../shared/models'
import type { ConnectorService } from '../connectors/connector-service'
import type { ConnectorSourceService } from '../sources/connector-source-service'
import type { SkillService } from '../skills/skill-service'
import type { SessionStore } from '../session/session-store'
import {
  memoryForgetInput,
  memorySaveInput,
  memorySearchInput,
  memoryUpdateInput,
} from '../memory/memory-tool-inputs'
import {
  editFileInput,
  editWorkspaceFile,
  writeFileInput,
  writeWorkspaceFile,
} from './workspace-editing'

const readFileInput = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(5_000).optional(),
})

const viewImageInput = z.object({
  path: z.string().min(1),
})

const sessionHistoryInput = z.object({
  startSeq: z.number().int().positive().optional(),
  endSeq: z.number().int().positive().optional(),
  query: z.string().trim().min(1).max(500).optional(),
  role: z.enum(['user', 'assistant', 'toolResult', 'system']).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict()

const connectorListInput = z.object({}).strict()
const watchCreateInput = z.object({
  provider: z.enum(['github', 'dingtalk']),
  connectorId: z.string().uuid().optional(),
  target: z.string().trim().max(500).default(''),
  actors: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  purpose: z.enum(['analysis', 'reply']).default('analysis'),
  instruction: z.string().trim().min(1).max(20_000),
}).strict()
const watchListInput = z.object({}).strict()
const watchCancelInput = z.object({ query: z.string().trim().min(1).max(500) }).strict()
const skillListInput = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict()
const skillReadInput = z.object({ id: z.string().trim().min(1).max(160) }).strict()
const skillFileInput = z.object({
  id: z.string().trim().min(1).max(160),
  path: z.string().trim().min(1).max(1_000),
}).strict()

const connectorCallInput = z.object({
  connectorId: z.string().uuid(),
  capability: z.string().trim().min(1).max(160),
  arguments: z.record(z.string(), z.unknown()).default({}),
}).strict()

const shellInput = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
})

const TOOL_INPUTS = {
  read_file: readFileInput,
  write_file: writeFileInput,
  edit_file: editFileInput,
  list_dir: listDirInput,
  search_files: searchFilesInput,
  find_files: findFilesInput,
  view_image: viewImageInput,
  shell: shellInput,
  memory_search: memorySearchInput,
  memory_save: memorySaveInput,
  memory_update: memoryUpdateInput,
  memory_forget: memoryForgetInput,
  connector_list: connectorListInput,
  connector_call: connectorCallInput,
  watch_create: watchCreateInput,
  watch_list: watchListInput,
  watch_cancel: watchCancelInput,
  skill_list: skillListInput,
  skill_read: skillReadInput,
  skill_file: skillFileInput,
  session_history: sessionHistoryInput,
} as const

const ROUTER_DIRECT_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'search_files',
  'find_files',
  'view_image',
  'memory_search',
  'memory_save',
  'memory_update',
  'memory_forget',
  'connector_list',
  'connector_call',
  'watch_create',
  'watch_list',
  'watch_cancel',
  'skill_list',
  'skill_read',
  'skill_file',
] as const satisfies readonly (keyof typeof TOOL_INPUTS)[]

const ROUTER_TOOL_DESCRIPTIONS: Record<(typeof ROUTER_DIRECT_TOOLS)[number], string> = {
  read_file: 'Read a UTF-8 text file inside the managed workspace, optionally by line range.',
  write_file: 'Create or completely overwrite a UTF-8 text file inside the managed workspace.',
  edit_file: 'Apply exact text replacements to an existing UTF-8 workspace file. Read it first.',
  list_dir: 'List files and folders in the managed workspace with bounded depth and entries.',
  search_files: 'Search UTF-8 workspace file contents by literal string or regular expression.',
  find_files: 'Find workspace files by glob pattern, respecting ignores and sensitive paths.',
  view_image: 'Attach a local PNG, JPEG, WebP, or GIF image from the managed workspace.',
  memory_search: 'Search durable cross-session memory for relevant preferences, facts, decisions, or procedures.',
  memory_save: 'Save a stable reusable preference, fact, procedure, or decision. Never save credentials.',
  memory_update: 'Correct one existing memory by id and expected version. Read memory_search results first.',
  memory_forget: 'Archive one durable memory entry by id.',
  connector_list: 'List configured connectors, their status, and every capability input schema. Call this before using a connector.',
  connector_call: 'Invoke one connector capability with arguments matching its declared inputSchema. Reads return immediately; approval-backed writes queue an Action.',
  watch_create: 'Create a durable background watch for a connected GitHub repository/user set or DingTalk conversation. Use the user’s instruction and reply purpose exactly; do not configure sources yourself.',
  watch_list: 'List active connector watches so the user can see or manage what Barn is monitoring.',
  watch_cancel: 'Stop one active connector watch by id, name, or DingTalk target name.',
  skill_list: 'List enabled user-installed skills and their summaries.',
  skill_read: 'Read the full instructions for one enabled skill.',
  skill_file: 'Read one supporting resource from an enabled skill folder.',
}

export interface ToolServiceOptions {
  workspaceRoot: string
  outputRoot: string
  privateTempRoot: string
  shell: ShellService
  memory?: MemoryService
  browser?: BrowserToolService
  connectors?: ConnectorService
  watches?: () => ConnectorSourceService | undefined
  skills?: SkillService
  sessions?: Pick<SessionStore, 'read'>
}

export interface ToolExecutionContext {
  workingDirectory?: string | undefined
  sessionId?: string | undefined
  taskId?: string | undefined
  signal?: AbortSignal | undefined
}

export class ToolService {
  private readonly defaultRoots: string[]

  constructor(private readonly options: ToolServiceOptions) {
    this.defaultRoots = [options.workspaceRoot, options.outputRoot, options.privateTempRoot]
      .map((root) => realpathSync.native(root))
  }

  /** Stable disclosure for the Router's single `call` envelope. */
  listRouterTools(): RouterToolDescriptor[] {
    return ROUTER_DIRECT_TOOLS.flatMap((name) => {
      if (name.startsWith('memory_') && this.options.memory === undefined) return []
      if (name.startsWith('connector_') && this.options.connectors === undefined) return []
      if (name.startsWith('watch_') && this.options.watches?.() === undefined) return []
      if (name.startsWith('skill_') && this.options.skills === undefined) return []
      return [{
        name,
        description: ROUTER_TOOL_DESCRIPTIONS[name],
        inputSchema: jsonObjectSchema(TOOL_INPUTS[name]),
      }]
    })
  }

  async execute(
    toolName: string,
    rawArgs: unknown,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    if (toolName.startsWith('browser_')) {
      const browser = this.options.browser
      if (browser === undefined) return errorResult('Browser tools are unavailable')
      return browser.execute(toolName, rawArgs, {
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      }, context.signal)
    }

    if (toolName === 'session_history') {
      const sessions = this.options.sessions
      if (sessions === undefined || context.sessionId === undefined) {
        return errorResult('Session history is unavailable for this run')
      }
      try {
        const args = sessionHistoryInput.parse(rawArgs)
        if (args.startSeq !== undefined && args.endSeq !== undefined && args.startSeq > args.endSeq) {
          return errorResult('startSeq must be less than or equal to endSeq')
        }
        const query = args.query?.toLocaleLowerCase()
        const messages = sessions.read(context.sessionId)
          .filter((event) => event.type === 'agent.message')
          .flatMap((event) => {
            const message = sessionEventMessage(event.data)
            if (message === undefined) return []
            if (args.role !== undefined && message.role !== args.role) return []
            if (args.startSeq !== undefined && event.seq < args.startSeq) return []
            if (args.endSeq !== undefined && event.seq > args.endSeq) return []
            if (query !== undefined && !message.text.toLocaleLowerCase().includes(query)) return []
            return [{ seq: event.seq, eventId: event.eventId, role: message.role, text: message.text }]
          })
        const selected: typeof messages = []
        let chars = 0
        for (const message of messages) {
          if (selected.length >= args.limit) break
          const text = truncateHistoryText(message.text, 6_000)
          if (chars + text.length > 40_000 && selected.length > 0) break
          selected.push({ ...message, text })
          chars += text.length
        }
        const lastSeq = selected.at(-1)?.seq
        const hasMore = lastSeq !== undefined && messages.some((message) => message.seq > lastSeq)
        const payload = {
          sessionId: context.sessionId,
          messages: selected,
          matched: messages.length,
          returned: selected.length,
          ...(hasMore && lastSeq !== undefined ? { nextStartSeq: lastSeq + 1 } : {}),
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          details: { matched: messages.length, returned: selected.length, truncated: hasMore || selected.some((message) => message.text.length >= 6_000) },
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    if (toolName === 'connector_list') {
      const connectors = this.options.connectors
      if (connectors === undefined) return errorResult('Connector tools are unavailable')
      try {
        const [definitions, instances] = await Promise.all([
          Promise.resolve(connectors.listDefinitions()),
          connectors.list(),
        ])
        return { content: [{ type: 'text', text: JSON.stringify({ definitions, instances }) }], details: { connectors: instances.length } }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    if (toolName === 'watch_create' || toolName === 'watch_list' || toolName === 'watch_cancel') {
      const watches = this.options.watches?.()
      if (watches === undefined) return errorResult('Connector watches are unavailable')
      try {
        if (toolName === 'watch_create') {
          const args = watchCreateInput.parse(rawArgs)
          const source = await watches.createWatch({
            provider: args.provider,
            ...(args.connectorId === undefined ? {} : { connectorId: args.connectorId }),
            target: args.target,
            actors: args.actors,
            keywords: args.keywords,
            purpose: args.purpose,
            instruction: args.instruction,
          })
          return {
            content: [{ type: 'text', text: JSON.stringify({ created: watchView(source) }) }],
            details: { sourceId: source.id, provider: source.config.kind, purpose: source.config.purpose ?? 'analysis' },
          }
        }
        if (toolName === 'watch_list') {
          const active = watches.listWatches().map(watchView)
          return {
            content: [{ type: 'text', text: JSON.stringify({ watches: active }) }],
            details: { watches: active.length },
          }
        }
        const args = watchCancelInput.parse(rawArgs)
        const removed = watches.cancelWatch(args.query)
        return {
          content: [{ type: 'text', text: JSON.stringify({ cancelled: watchView(removed) }) }],
          details: { sourceId: removed.id },
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    if (toolName === 'connector_call') {
      const connectors = this.options.connectors
      if (connectors === undefined) return errorResult('Connector tools are unavailable')
      try {
        const args = connectorCallInput.parse(rawArgs)
        const result = await connectors.call(args, {
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { kind: result.kind } }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    if (toolName === 'skill_list') {
      const skills = this.options.skills
      if (skills === undefined) return errorResult('Skill tools are unavailable')
      try {
        const args = skillListInput.parse(rawArgs)
        const query = args.query?.toLocaleLowerCase()
        const summaries = skills.list()
          .filter((skill) => skill.enabled)
          .filter((skill) => query === undefined || `${skill.name} ${skill.description} ${skill.providerLabel}`.toLocaleLowerCase().includes(query))
          .slice(0, args.limit)
        return {
          content: [{ type: 'text', text: JSON.stringify({ skills: summaries }) }],
          details: { skills: summaries.length },
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    if (toolName === 'skill_read') {
      const skills = this.options.skills
      if (skills === undefined) return errorResult('Skill tools are unavailable')
      try {
        const args = skillReadInput.parse(rawArgs)
        const skill = await skills.get(args.id)
        if (!skill.enabled) return errorResult(`Skill is disabled: ${args.id}`)
        return {
          content: [{ type: 'text', text: JSON.stringify(skill) }],
          details: { skillId: skill.id, source: skill.source },
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    if (toolName === 'skill_file') {
      const skills = this.options.skills
      if (skills === undefined) return errorResult('Skill tools are unavailable')
      try {
        const args = skillFileInput.parse(rawArgs)
        const skill = await skills.get(args.id)
        if (!skill.enabled) return errorResult(`Skill is disabled: ${args.id}`)
        const file = await skills.readFile(args.id, args.path)
        return {
          content: [{
            type: 'text',
            text: file.text ?? `Binary skill resource: ${file.path}\nSize: ${file.size} bytes\nMedia type: ${file.mediaType}`,
          }],
          details: { skillId: skill.id, path: file.path, size: file.size, binary: file.binary },
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }

    const input = TOOL_INPUTS[toolName as keyof typeof TOOL_INPUTS]
    if (input === undefined) {
      return errorResult(`Unknown tool: ${toolName}`)
    }

    try {
      context.signal?.throwIfAborted()
      const args = input.parse(rawArgs)
      const workingRoot = context.workingDirectory === undefined
        ? this.options.workspaceRoot
        : await realpath(context.workingDirectory)
      const roots = [...new Set([workingRoot, ...this.defaultRoots])]
      switch (toolName) {
        case 'read_file':
          return await this.readFile(args as z.infer<typeof readFileInput>, roots, workingRoot)
        case 'write_file':
          return await this.writeFile(args as z.infer<typeof writeFileInput>, roots, workingRoot)
        case 'edit_file':
          return await this.editFile(args as z.infer<typeof editFileInput>, roots, workingRoot)
        case 'list_dir':
          return await this.listDirectory(args as z.infer<typeof listDirInput>, roots, workingRoot)
        case 'search_files':
          return await this.searchFiles(args as z.infer<typeof searchFilesInput>, roots, workingRoot)
        case 'find_files':
          return await this.findFiles(args as z.infer<typeof findFilesInput>, roots, workingRoot)
        case 'view_image':
          return await this.viewImage(args as z.infer<typeof viewImageInput>, roots, workingRoot)
        case 'shell':
          return await this.runShell(args as z.infer<typeof shellInput>, workingRoot, context.signal)
        case 'memory_search':
          return this.memorySearch(args as z.infer<typeof memorySearchInput>, workingRoot, context.sessionId)
        case 'memory_save':
          return this.memorySave(args as z.infer<typeof memorySaveInput>, workingRoot)
        case 'memory_update':
          return this.memoryUpdate(args as z.infer<typeof memoryUpdateInput>)
        case 'memory_forget':
          return this.memoryForget(args as z.infer<typeof memoryForgetInput>)
        default:
          return errorResult(`Unknown tool: ${toolName}`)
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }

  private async readFile(
    input: z.infer<typeof readFileInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path, roots, defaultRoot)
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Not a file: ${input.path}`)
    if (info.size > 20 * 1024 * 1024) throw new Error('File is too large to read directly')

    const bytes = await readFile(path)
    if (!isUtf8(bytes)) {
      return {
        content: [{
          type: 'text',
          text: `Binary file: ${input.path}\nSize: ${info.size} bytes\nUse shell tools to extract text or view_image for supported image files.`,
        }],
        details: {
          path,
          size: info.size,
          binary: true,
        },
      }
    }

    const lines = bytes.toString('utf8').split(/\r?\n/)
    const startIndex = (input.startLine ?? 1) - 1
    const count = input.lineCount ?? 2_000
    const selected = lines.slice(startIndex, startIndex + count)
    const endLine = Math.min(startIndex + selected.length, lines.length)
    return {
      content: [{
        type: 'text',
        text: selected.map((line, index) => `${startIndex + index + 1}: ${line}`).join('\n'),
      }],
      details: {
        path,
        size: info.size,
        startLine: startIndex + 1,
        endLine,
        totalLines: lines.length,
        truncated: endLine < lines.length,
      },
    }
  }

  private async writeFile(
    input: z.infer<typeof writeFileInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeWritablePath(input.path, roots, defaultRoot)
    return writeWorkspaceFile(path, input.content)
  }

  private async editFile(
    input: z.infer<typeof editFileInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path, roots, defaultRoot)
    return editWorkspaceFile(path, input.edits)
  }

  private async listDirectory(
    input: z.infer<typeof listDirInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path, roots, defaultRoot)
    if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${input.path}`)
    return listWorkspaceDirectory(path, input)
  }

  private async searchFiles(
    input: z.infer<typeof searchFilesInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path, roots, defaultRoot)
    return searchWorkspaceContents(path, input)
  }

  private async findFiles(
    input: z.infer<typeof findFilesInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path, roots, defaultRoot)
    return findWorkspaceFiles(path, input)
  }

  private async viewImage(
    input: z.infer<typeof viewImageInput>,
    roots: string[],
    defaultRoot: string,
  ): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path, roots, defaultRoot)
    const mimeType = imageMimeType(path)
    if (mimeType === undefined) throw new Error(`Unsupported image type: ${extname(path) || '(none)'}`)
    const info = await stat(path)
    if (info.size > 20 * 1024 * 1024) throw new Error('Image is too large to attach')
    const bytes = await readFile(path)
    return {
      content: [{
        type: 'image',
        data: bytes.toString('base64'),
        mimeType,
      }],
      details: { path, size: info.size, mimeType },
    }
  }

  private memorySearch(
    input: z.infer<typeof memorySearchInput>,
    workingRoot: string,
    sessionId?: string,
  ): ToolExecutionResult {
    const memory = this.requireMemory()
    const entries = memory.search(input.query, workingRoot, input.limit, input.scope, sessionId)
    return {
      content: [{ type: 'text', text: entries.length === 0 ? 'No matching memory entries.' : JSON.stringify({ memories: entries }, null, 2) }],
      details: { count: entries.length, ids: entries.map((entry) => entry.id) },
    }
  }

  private memorySave(
    input: z.infer<typeof memorySaveInput>,
    workingRoot: string,
  ): ToolExecutionResult {
    const entry = this.requireMemory().save({
      kind: input.kind,
      scope: input.scope,
      title: input.title,
      content: input.content,
      tags: input.tags,
      pinned: input.pinned,
      sourceAuthority: 'inferred',
      status: 'candidate',
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...(input.scope === 'workspace' ? { workspacePath: workingRoot } : {}),
    })
    return {
      content: [{ type: 'text', text: `Saved memory: ${entry.title}` }],
      details: { id: entry.id, version: entry.version },
    }
  }

  private memoryForget(input: z.infer<typeof memoryForgetInput>): ToolExecutionResult {
    const memory = this.requireMemory()
    if (!memory.getSettings().enabled) throw new Error('Agent memory is disabled')
    memory.forget(input.id)
    return {
      content: [{ type: 'text', text: `Forgot memory ${input.id}` }],
      details: { id: input.id },
    }
  }

  private memoryUpdate(input: z.infer<typeof memoryUpdateInput>): ToolExecutionResult {
    const change: MemoryUpdateInput = {
      id: input.id,
      expectedVersion: input.expectedVersion,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
    }
    const entry = this.requireMemory().update(change)
    return {
      content: [{ type: 'text', text: `Updated memory: ${entry.title}` }],
      details: { id: entry.id, version: entry.version },
    }
  }

  private requireMemory(): MemoryService {
    if (this.options.memory === undefined) throw new Error('Agent memory is not available')
    return this.options.memory
  }

  private async runShell(
    input: z.infer<typeof shellInput>,
    workingRoot: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    signal?.throwIfAborted()
    const cwd = await this.safeExistingPath(input.cwd, [workingRoot, ...this.defaultRoots], workingRoot)
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${input.cwd}`)
    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: workingRoot,
      outputRoot: this.options.outputRoot,
      privateTempRoot: this.options.privateTempRoot,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    const result = await this.options.shell.run({
      command: input.command,
      cwd,
      policy,
      ...(signal === undefined ? {} : { signal }),
    })
    const text = [
      `Exit code: ${result.exitCode ?? 'unknown'}`,
      result.stdout.length > 0 ? `\nSTDOUT\n${result.stdout}` : '',
      result.stderr.length > 0 ? `\nSTDERR\n${result.stderr}` : '',
      result.timedOut ? '\nTimed out.' : '',
      result.aborted ? '\nAborted.' : '',
    ].join('')
    return {
      content: [{ type: 'text', text }],
      details: {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        sandbox: result.sandbox,
      },
      ...(result.exitCode === 0 ? {} : { isError: true }),
    }
  }

  private async safeExistingPath(input: string, roots: string[], defaultRoot: string): Promise<string> {
    const candidate = isAbsolute(input) ? input : resolve(defaultRoot, input)
    const canonical = await realpath(candidate)
    this.assertAllowed(canonical, roots)
    return canonical
  }

  private async safeWritablePath(input: string, roots: string[], defaultRoot: string): Promise<string> {
    const candidate = isAbsolute(input) ? resolve(input) : resolve(defaultRoot, input)
    this.assertAllowed(candidate, roots)
    const ancestor = await this.nearestExistingAncestor(candidate)
    const canonicalAncestor = await realpath(ancestor)
    const canonical = resolve(canonicalAncestor, relative(ancestor, candidate))
    this.assertAllowed(canonical, roots)
    return canonical
  }

  private async nearestExistingAncestor(path: string): Promise<string> {
    let current = path
    while (true) {
      try {
        await stat(current)
        return current
      } catch (error) {
        if (!isMissingPath(error)) throw error
        const parent = dirname(current)
        if (parent === current) throw error
        current = parent
      }
    }
  }

  private assertAllowed(path: string, roots: string[]): void {
    if (isDeniedPath(path)) throw new Error('Access to this path is denied')
    const allowed = roots.some((root) => {
      const rel = relative(root, path)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    })
    if (!allowed) throw new Error('Path is outside the managed workspace')
  }
}

function jsonObjectSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  delete generated.$schema
  return generated
}

function imageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}

function sessionEventMessage(data: unknown): { role: 'user' | 'assistant' | 'toolResult' | 'system'; text: string } | undefined {
  if (!isRecord(data) || !isRecord(data.message)) return undefined
  const role = data.message.role
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult' && role !== 'system') return undefined
  const content = data.message.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((block): string[] => (
          isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        )).join('\n')
      : ''
  if (text.trim().length === 0) return undefined
  return { role, text }
}

function truncateHistoryText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `\n\n[message truncated; request a narrower session_history range for the rest]\n\n`
  const available = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(available * 0.65)
  const tail = Math.max(0, available - head)
  return `${value.slice(0, head)}${marker}${tail === 0 ? '' : value.slice(-tail)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function watchView(source: import('../../shared/models').ConnectorSource): Record<string, unknown> {
  return {
    id: source.id,
    name: source.name,
    provider: source.config.kind,
    enabled: source.enabled,
    purpose: source.config.purpose ?? 'analysis',
    instruction: source.config.instruction,
    ...(source.config.kind === 'github'
      ? {
          scope: source.config.scope ?? 'repository',
          repository: source.config.owner === undefined ? undefined : `${source.config.owner}/${source.config.repo}`,
          actors: source.config.actors ?? [],
        }
      : { target: source.config.targetLabel ?? source.config.conversationId ?? source.config.userId, keywords: source.config.keywords }),
    lastCheckedAt: source.lastCheckedAt,
    lastError: source.lastError,
  }
}

function errorResult(message: string): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
    isError: true,
  }
}
