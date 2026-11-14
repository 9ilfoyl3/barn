import { isUtf8 } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolExecutionResult } from '../../shared/agent-protocol'
import type { ShellService } from '../sandbox/shell-service'
import { resolveSandboxPolicy } from '../sandbox/policy'

const readFileInput = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(5_000).optional(),
})

const listDirInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(4).default(1),
})

const searchFilesInput = z.object({
  path: z.string().default('.'),
  query: z.string().min(1).max(500),
  maxResults: z.number().int().positive().max(500).default(100),
})

const viewImageInput = z.object({
  path: z.string().min(1),
})

const shellInput = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
})

const TOOL_INPUTS = {
  read_file: readFileInput,
  list_dir: listDirInput,
  search_files: searchFilesInput,
  view_image: viewImageInput,
  shell: shellInput,
} as const

export interface ToolServiceOptions {
  workspaceRoot: string
  outputRoot: string
  privateTempRoot: string
  shell: ShellService
}

export class ToolService {
  private readonly roots: string[]

  constructor(private readonly options: ToolServiceOptions) {
    this.roots = [options.workspaceRoot, options.outputRoot, options.privateTempRoot]
      .map((root) => realpathSync.native(root))
  }

  async execute(toolName: string, rawArgs: unknown): Promise<ToolExecutionResult> {
    const input = TOOL_INPUTS[toolName as keyof typeof TOOL_INPUTS]
    if (input === undefined) {
      return errorResult(`Unknown tool: ${toolName}`)
    }

    try {
      const args = input.parse(rawArgs)
      switch (toolName) {
        case 'read_file':
          return await this.readFile(args as z.infer<typeof readFileInput>)
        case 'list_dir':
          return await this.listDirectory(args as z.infer<typeof listDirInput>)
        case 'search_files':
          return await this.searchFiles(args as z.infer<typeof searchFilesInput>)
        case 'view_image':
          return await this.viewImage(args as z.infer<typeof viewImageInput>)
        case 'shell':
          return await this.runShell(args as z.infer<typeof shellInput>)
        default:
          return errorResult(`Unknown tool: ${toolName}`)
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }

  private async readFile(input: z.infer<typeof readFileInput>): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path)
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

  private async listDirectory(input: z.infer<typeof listDirInput>): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path)
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error(`Not a directory: ${input.path}`)
    const entries = await this.listEntries(path, input.depth)
    return {
      content: [{ type: 'text', text: entries.join('\n') || '(empty directory)' }],
      details: { path, entries: entries.length, depth: input.depth },
    }
  }

  private async searchFiles(input: z.infer<typeof searchFilesInput>): Promise<ToolExecutionResult> {
    const root = await this.safeExistingPath(input.path)
    const matches: string[] = []
    let scanned = 0
    let skipped = 0

    const visit = async (directory: string): Promise<void> => {
      if (matches.length >= input.maxResults) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (matches.length >= input.maxResults) return
        if (entry.name === 'node_modules' || entry.name === '.git') {
          skipped++
          continue
        }
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(path)
          continue
        }
        if (!entry.isFile()) continue
        const info = await stat(path)
        if (info.size > 2 * 1024 * 1024) {
          skipped++
          continue
        }
        const bytes = await readFile(path)
        if (!isUtf8(bytes)) {
          skipped++
          continue
        }
        scanned++
        const lines = bytes.toString('utf8').split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? ''
          if (line.includes(input.query)) {
            matches.push(`${relative(root, path)}:${index + 1}:${line.slice(0, 500)}`)
            if (matches.length >= input.maxResults) return
          }
        }
      }
    }

    if ((await stat(root)).isDirectory()) await visit(root)
    else throw new Error(`Not a directory: ${input.path}`)

    return {
      content: [{ type: 'text', text: matches.join('\n') || `No matches for ${JSON.stringify(input.query)}` }],
      details: { path: root, matches: matches.length, scanned, skipped },
    }
  }

  private async viewImage(input: z.infer<typeof viewImageInput>): Promise<ToolExecutionResult> {
    const path = await this.safeExistingPath(input.path)
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

  private async runShell(input: z.infer<typeof shellInput>): Promise<ToolExecutionResult> {
    const cwd = await this.safeExistingPath(input.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${input.cwd}`)
    const policy = resolveSandboxPolicy({
      mode: 'workspace-write',
      workspaceRoot: this.options.workspaceRoot,
      outputRoot: this.options.outputRoot,
      privateTempRoot: this.options.privateTempRoot,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    const result = await this.options.shell.run({
      command: input.command,
      cwd,
      policy,
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

  private async safeExistingPath(input: string): Promise<string> {
    const candidate = isAbsolute(input) ? input : resolve(this.options.workspaceRoot, input)
    const canonical = await realpath(candidate)
    this.assertAllowed(canonical)
    return canonical
  }

  private assertAllowed(path: string): void {
    if (isDeniedPath(path)) throw new Error('Access to this path is denied')
    const allowed = this.roots.some((root) => {
      const rel = relative(root, path)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    })
    if (!allowed) throw new Error('Path is outside the managed workspace')
  }

  private async listEntries(root: string, depth: number): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true })
    const lines: string[] = []
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(root, entry.name)
      if (entry.isDirectory()) {
        lines.push(`${relative(this.options.workspaceRoot, path)}/`)
        if (depth > 0) {
          const children = await this.listEntries(path, depth - 1)
          lines.push(...children.map((child) => `${relative(this.options.workspaceRoot, path)}/${child}`))
        }
      } else {
        const info = await stat(path)
        lines.push(`${relative(this.options.workspaceRoot, path)} (${info.size} bytes)`)
      }
    }
    return lines
  }
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

function isDeniedPath(path: string): boolean {
  const name = basename(path).toLowerCase()
  return name === '.env'
    || name.startsWith('.env.')
    || name === 'credentials'
    || name === 'id_rsa'
    || name === 'id_ed25519'
    || name.includes('keychain')
}

function errorResult(message: string): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
    isError: true,
  }
}
