import { isUtf8 } from 'node:buffer'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { minimatch } from 'minimatch'
import { z } from 'zod'
import type { ToolExecutionResult } from '../../shared/agent-protocol'
import { isDeniedPath, isGeneratedDirectory } from './workspace-path-policy'

const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_LINE_CHARS = 500

export const listDirInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(4).default(1),
  maxEntries: z.number().int().positive().max(2_000).default(500),
})

export const searchFilesInput = z.object({
  path: z.string().default('.'),
  query: z.string().min(1).max(500),
  literal: z.boolean().default(true),
  ignoreCase: z.boolean().default(false),
  glob: z.string().min(1).max(500).optional(),
  context: z.number().int().min(0).max(10).default(0),
  maxResults: z.number().int().positive().max(500).default(100),
})

export const findFilesInput = z.object({
  path: z.string().default('.'),
  pattern: z.string().min(1).max(500).default('*'),
  includeDirectories: z.boolean().default(false),
  maxResults: z.number().int().positive().max(1_000).default(500),
})

export async function listWorkspaceDirectory(
  root: string,
  input: z.infer<typeof listDirInput>,
): Promise<ToolExecutionResult> {
  const entries: string[] = []
  let truncated = false

  const visit = async (directory: string, depth: number, prefix: string): Promise<void> => {
    if (entries.length >= input.maxEntries) {
      truncated = true
      return
    }
    const children = (await readdir(directory, { withFileTypes: true }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (entries.length >= input.maxEntries) {
        truncated = true
        return
      }
      const childPath = resolve(directory, child.name)
      if (isDeniedPath(childPath)) continue
      const display = prefix.length === 0 ? child.name : `${prefix}/${child.name}`
      if (child.isDirectory()) {
        entries.push(`${display}/`)
        if (depth > 0 && !isGeneratedDirectory(child.name)) {
          await visit(childPath, depth - 1, display)
        }
      } else if (child.isFile()) {
        entries.push(display)
      }
    }
  }

  await visit(root, input.depth, '')
  const text = entries.join('\n') || '(empty directory)'
  return {
    content: [{ type: 'text', text: truncated ? `${text}\n\n[${input.maxEntries} entries limit reached]` : text }],
    details: { path: root, entries: entries.length, depth: input.depth, truncated },
  }
}

export async function findWorkspaceFiles(
  root: string,
  input: z.infer<typeof findFilesInput>,
): Promise<ToolExecutionResult> {
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error(`Not a directory: ${input.path}`)

  const gitignore = await readGitignore(root)
  const matches: string[] = []
  let skipped = 0
  let limitReached = false

  const visit = async (directory: string): Promise<void> => {
    if (matches.length >= input.maxResults) {
      limitReached = true
      return
    }
    const children = (await readdir(directory, { withFileTypes: true }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (matches.length >= input.maxResults) {
        limitReached = true
        return
      }
      const childPath = resolve(directory, child.name)
      const rel = toPosix(relative(root, childPath))
      if (child.isSymbolicLink() || isDeniedPath(childPath) || isIgnored(gitignore, rel, child.isDirectory())) {
        skipped++
        continue
      }
      if (child.isDirectory()) {
        if (input.includeDirectories && matchesPath(rel, input.pattern, false)) {
          matches.push(`${rel}/`)
          if (matches.length >= input.maxResults) {
            limitReached = true
            return
          }
        }
        if (!isGeneratedDirectory(child.name)) await visit(childPath)
      } else if (child.isFile() && matchesPath(rel, input.pattern, false)) {
        matches.push(rel)
      }
    }
  }

  await visit(root)
  const text = matches.join('\n') || `No files found matching ${JSON.stringify(input.pattern)}`
  return {
    content: [{ type: 'text', text: limitReached ? `${text}\n\n[${input.maxResults} results limit reached; refine the pattern]` : text }],
    details: { path: root, matches: matches.length, skipped, limitReached },
  }
}

interface MatchGroup {
  lines: string[]
}

export async function searchWorkspaceContents(
  root: string,
  input: z.infer<typeof searchFilesInput>,
): Promise<ToolExecutionResult> {
  const matcher = compileMatcher(input.query, input.literal, input.ignoreCase)
  const rootInfo = await stat(root)
  const groups: MatchGroup[] = []
  let scanned = 0
  let skipped = 0
  let matches = 0
  let matchingFiles = 0
  let limitReached = false

  const searchFile = async (path: string, displayPath: string): Promise<void> => {
    const info = await stat(path)
    if (info.size > MAX_SEARCH_FILE_BYTES) {
      skipped++
      return
    }
    const bytes = await readFile(path)
    if (!isUtf8(bytes)) {
      skipped++
      return
    }
    scanned++
    const lines = bytes.toString('utf8').split(/\r?\n/)
    const matchingLineIndexes: number[] = []
    for (let index = 0; index < lines.length; index++) {
      matcher.lastIndex = 0
      if (matcher.test(lines[index] ?? '')) {
        matchingLineIndexes.push(index)
        matches++
        if (matches >= input.maxResults) {
          limitReached = true
          break
        }
      }
    }
    if (matchingLineIndexes.length === 0) return
    matchingFiles++
    const intervals = mergeIntervals(matchingLineIndexes, input.context, lines.length - 1)
    const outputLines: string[] = []
    for (const [start, end] of intervals) {
      for (let index = start; index <= end; index++) {
        outputLines.push(`${displayPath}:${index + 1}:${(lines[index] ?? '').slice(0, MAX_LINE_CHARS)}`)
      }
    }
    groups.push({ lines: outputLines })
  }

  if (rootInfo.isFile()) {
    const displayPath = basename(root)
    if (matchesPath(displayPath, input.glob, false)) await searchFile(root, displayPath)
  } else {
    const gitignore = await readGitignore(root)
    const visit = async (directory: string): Promise<void> => {
      if (limitReached) return
      const children = (await readdir(directory, { withFileTypes: true }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
      for (const child of children) {
        if (limitReached) return
        const childPath = resolve(directory, child.name)
        const rel = toPosix(relative(root, childPath))
        if (child.isSymbolicLink() || isDeniedPath(childPath) || isIgnored(gitignore, rel, child.isDirectory())) {
          skipped++
          continue
        }
        if (child.isDirectory()) {
          if (!isGeneratedDirectory(child.name)) await visit(childPath)
        } else if (child.isFile() && matchesPath(rel, input.glob, false)) {
          await searchFile(childPath, rel)
        }
      }
    }
    await visit(root)
  }

  const output = renderResults(groups)
  const text = output.text || `No matches for ${JSON.stringify(input.query)}`
  const notices: string[] = []
  if (limitReached) notices.push(`${input.maxResults} matches limit reached; use a narrower glob or query`)
  if (output.truncated) notices.push('50KB output limit reached')
  return {
    content: [{ type: 'text', text: notices.length === 0 ? text : `${text}\n\n[${notices.join('. ')}]` }],
    details: {
      path: root,
      matches,
      matchingFiles,
      scanned,
      skipped,
      limitReached,
      outputTruncated: output.truncated,
    },
  }
}

function compileMatcher(query: string, literal: boolean, ignoreCase: boolean): RegExp {
  const pattern = literal ? escapeRegExp(query) : query
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mergeIntervals(indexes: number[], context: number, lastLineIndex: number): Array<[number, number]> {
  const intervals: Array<[number, number]> = []
  for (const index of indexes) {
    const start = Math.max(0, index - context)
    const end = Math.min(lastLineIndex, index + context)
    const previous = intervals.at(-1)
    if (previous !== undefined && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end)
    else intervals.push([start, end])
  }
  return intervals
}

function renderResults(groups: MatchGroup[]): { text: string; truncated: boolean } {
  const lines: string[] = []
  let bytes = 0
  for (const group of groups) {
    for (const line of group.lines) {
      const lineBytes = Buffer.byteLength(`${line}\n`)
      if (bytes + lineBytes > MAX_OUTPUT_BYTES) return { text: lines.join('\n'), truncated: true }
      lines.push(line)
      bytes += lineBytes
    }
  }
  return { text: lines.join('\n'), truncated: false }
}

async function readGitignore(root: string): Promise<Ignore | undefined> {
  try {
    return ignore().add(await readFile(resolve(root, '.gitignore'), 'utf8'))
  } catch {
    return undefined
  }
}

function isIgnored(gitignore: Ignore | undefined, rel: string, directory: boolean): boolean {
  if (gitignore === undefined) return false
  return gitignore.ignores(directory ? `${rel}/` : rel)
}

function matchesPath(path: string, pattern: string | undefined, ignoreCase: boolean): boolean {
  if (pattern === undefined) return true
  return minimatch(path, pattern, {
    dot: true,
    matchBase: !pattern.includes('/'),
    nocase: ignoreCase,
  })
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}
