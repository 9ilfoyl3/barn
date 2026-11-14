import { isUtf8 } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { ToolExecutionResult } from '../../shared/agent-protocol'

const MAX_WRITE_BYTES = 10 * 1024 * 1024
const MAX_EDIT_FILE_BYTES = 20 * 1024 * 1024

export const writeFileInput = z.object({
  path: z.string().min(1).max(4_000),
  content: z.string().max(5_000_000),
})

export const editFileInput = z.object({
  path: z.string().min(1).max(4_000),
  edits: z.array(z.object({
    oldText: z.string().min(1).max(500_000),
    newText: z.string().max(500_000),
  })).min(1).max(50),
})

export async function writeWorkspaceFile(
  path: string,
  content: string,
): Promise<ToolExecutionResult> {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE_BYTES) throw new Error('File content is too large to write directly')

  const existing = await stat(path).catch((error: unknown) => {
    if (isMissingFile(error)) return undefined
    throw error
  })
  if (existing !== undefined && !existing.isFile()) throw new Error(`Not a file: ${path}`)

  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const mode = existing === undefined ? 0o600 : existing.mode & 0o777
  await atomicWriteFile(path, content, mode)
  return {
    content: [{ type: 'text', text: `Successfully wrote ${bytes} bytes to ${path}` }],
    details: { path, bytes, created: existing === undefined },
  }
}

export async function editWorkspaceFile(
  path: string,
  edits: z.infer<typeof editFileInput>['edits'],
): Promise<ToolExecutionResult> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Not a file: ${path}`)
  if (info.size > MAX_EDIT_FILE_BYTES) throw new Error('File is too large to edit directly')

  const bytes = await readFile(path)
  if (!isUtf8(bytes)) throw new Error('Cannot edit a binary file')
  const rawContent = bytes.toString('utf8')
  const bom = rawContent.startsWith('\uFEFF') ? '\uFEFF' : ''
  const original = bom.length === 0 ? rawContent : rawContent.slice(1)
  const { text: normalized, boundaries } = normalizeLineEndings(original)
  const replacements = edits.map((edit, index) => {
    const oldText = normalizeLineEndings(edit.oldText).text
    const occurrences = countOccurrences(normalized, oldText)
    if (occurrences === 0) {
      throw new Error(`Could not find edits[${index}].oldText in ${path}. It must match exactly after line-ending normalization.`)
    }
    if (occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of edits[${index}].oldText in ${path}. Each oldText must be unique; provide more context.`)
    }
    return {
      index,
      start: normalized.indexOf(oldText),
      length: oldText.length,
      newText: normalizeLineEndings(edit.newText).text,
    }
  }).toSorted((a, b) => a.start - b.start)

  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1]
    const current = replacements[index]
    if (previous === undefined || current === undefined) continue
    if (previous.start + previous.length > current.start) {
      throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`)
    }
  }

  const lineEnding = detectLineEnding(original)
  let output = ''
  let position = 0
  for (const replacement of replacements) {
    const start = boundaries[replacement.start]
    const end = boundaries[replacement.start + replacement.length]
    if (start === undefined || end === undefined) throw new Error(`Could not map edit offsets in ${path}`)
    output += original.slice(position, start)
    output += applyLineEnding(replacement.newText, lineEnding)
    position = end
  }
  output += original.slice(position)
  if (bom.length > 0) output = `${bom}${output}`
  if (output === rawContent) throw new Error(`No changes made to ${path}; replacements produced identical content`)

  const current = await stat(path)
  if (current.size !== info.size || current.mtimeMs !== info.mtimeMs) {
    throw new Error(`File changed while it was being edited: ${path}`)
  }
  await atomicWriteFile(path, output, info.mode & 0o777)
  const outputBytes = Buffer.byteLength(output, 'utf8')
  return {
    content: [{ type: 'text', text: `Successfully applied ${edits.length} edits to ${path}` }],
    details: { path, edits: edits.length, bytes: outputBytes },
  }
}

async function atomicWriteFile(path: string, content: string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.barn-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function normalizeLineEndings(value: string): { text: string; boundaries: number[] } {
  const boundaries: number[] = []
  let text = ''
  let index = 0
  while (index < value.length) {
    boundaries.push(index)
    if (value[index] === '\r' && value[index + 1] === '\n') {
      text += '\n'
      index += 2
    } else if (value[index] === '\r') {
      text += '\n'
      index += 1
    } else {
      text += value[index]
      index += 1
    }
  }
  boundaries.push(value.length)
  return { text, boundaries }
}

function detectLineEnding(value: string): '\r\n' | '\n' | '\r' {
  if (value.includes('\r\n')) return '\r\n'
  if (value.includes('\n')) return '\n'
  return value.includes('\r') ? '\r' : '\n'
}

function applyLineEnding(value: string, lineEnding: '\r\n' | '\n' | '\r'): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  return lineEnding === '\n' ? normalized : normalized.replaceAll('\n', lineEnding)
}

function countOccurrences(content: string, search: string): number {
  let count = 0
  let position = 0
  while (true) {
    const index = content.indexOf(search, position)
    if (index === -1) return count
    count++
    position = index + search.length
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}
