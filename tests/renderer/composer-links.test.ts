import { describe, expect, it } from 'vitest'
import { promptTextSegments } from '../../src/renderer/composer-links'

describe('promptTextSegments', () => {
  it('keeps surrounding text while separating links pasted after it', () => {
    expect(promptTextSegments('Read this https://example.com/page, then summarize it.'))
      .toEqual([
        { kind: 'text', text: 'Read this ' },
        { kind: 'link', text: 'https://example.com/page' },
        { kind: 'text', text: ', then summarize it.' },
      ])
  })

  it('supports multiple and www links without changing the source text', () => {
    const value = 'Compare www.example.com/a and https://example.com/b.'
    const segments = promptTextSegments(value)
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'link', 'text', 'link', 'text'])
    expect(segments.map((segment) => segment.text).join('')).toBe(value)
  })
})
