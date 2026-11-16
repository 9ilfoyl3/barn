import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl, isAllowedBrowserUrl } from '../../src/main/browser/browser-policy'

describe('browser policy', () => {
  it('normalizes hostnames to HTTPS', () => {
    expect(normalizeBrowserUrl('example.com/path')).toBe('https://example.com/path')
  })

  it('preserves explicit HTTP URLs for local fixtures', () => {
    expect(normalizeBrowserUrl('http://127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app')
  })

  it('rejects dangerous schemes', () => {
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow(/not allowed/i)
    expect(isAllowedBrowserUrl('file:///tmp/secret')).toBe(false)
    expect(isAllowedBrowserUrl('https://example.com')).toBe(true)
  })
})
