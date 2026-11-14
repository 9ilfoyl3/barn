import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { validateNote } from '../../scripts/verify-agent-notes'

const validNote = `# Agent Note: Windows paths

Status: implemented

## Problem
## Decision
## Alternatives considered
## Consequences
`

describe('verify-agent-notes', () => {
  it('accepts Windows relative paths', () => {
    const path = join('root', '.agents', 'notes', 'implemented', 'architecture', '2026-11-14-windows-paths.md')
      .replaceAll('/', '\\')
    expect(validateNote(path, validNote)).toEqual([])
  })

  it('rejects notes outside a known lifecycle', () => {
    const path = join('root', '.agents', 'notes', 'unknown', 'architecture', '2026-11-14-windows-paths.md')
    expect(validateNote(path, validNote).some((error) => error.includes('unknown lifecycle'))).toBe(true)
  })
})
