import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const notesRoot = join(root, '.agents/notes')
const lifecycleStatus = {
  proposed: 'proposed',
  implemented: 'implemented',
} as const
const classes = new Set([
  'feature',
  'bug-fix',
  'simplification',
  'architecture',
  'process',
  'testing',
])
const proposedSections = [
  '## Problem',
  '## Proposal',
  '## Alternatives considered',
  '## Acceptance criteria',
  '## Risks',
]
const implementedSections = [
  '## Problem',
  '## Decision',
  '## Alternatives considered',
  '## Consequences',
]

async function listMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listMarkdown(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

export function validateNote(path: string, content: string): string[] {
  const errors: string[] = []
  const relativePath = relative(root, path)
  if (basename(path) === 'README.md' || basename(path) === 'AGENTS.md') return errors

  const segments = relativePath.split(/[\\/]/)
  const notesIndex = segments.indexOf('notes')
  const lifecycle = segments[notesIndex + 1]
  const noteClass = segments[notesIndex + 2]
  const filename = segments.at(-1) ?? ''

  if (!isLifecycle(lifecycle)) errors.push(`${relativePath}: unknown lifecycle`)
  if (!classes.has(noteClass ?? '')) errors.push(`${relativePath}: unknown class`)
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(filename)) {
    errors.push(`${relativePath}: filename must start with YYYY-MM-DD-`)
  }

  const lines = content.split('\n')
  if (!lines[0]?.startsWith('# Agent Note: ')) {
    errors.push(`${relativePath}: first line must be "# Agent Note: <title>"`)
  }
  if (lines[1] !== '') errors.push(`${relativePath}: second line must be blank`)
  const expectedStatus = isLifecycle(lifecycle) ? lifecycleStatus[lifecycle] : undefined
  if (expectedStatus && lines[2] !== `Status: ${expectedStatus}`) {
    errors.push(`${relativePath}: status does not match lifecycle`)
  }

  const required = lifecycle === 'proposed' ? proposedSections : implementedSections
  for (const heading of required) {
    if (!content.includes(`\n${heading}\n`)) {
      errors.push(`${relativePath}: missing ${heading}`)
    }
  }
  return errors
}

function isLifecycle(value: string | undefined): value is keyof typeof lifecycleStatus {
  return value === 'proposed' || value === 'implemented'
}

export async function verifyAgentNotes(): Promise<string[]> {
  const errors: string[] = []
  for (const path of await listMarkdown(notesRoot)) {
    errors.push(...validateNote(path, await readFile(path, 'utf8')))
  }
  return errors
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await verifyAgentNotes()
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Agent Notes are valid.')
  }
}
