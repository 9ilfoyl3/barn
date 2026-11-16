import { describe, expect, it } from 'vitest'
import { isAllowedBrowserUrl, isBlockedBrowserHost, normalizeBrowserUrl } from '../../src/main/browser/browser-policy'

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

  it('allows loopback development addresses', () => {
    expect(isAllowedBrowserUrl('http://localhost:3000')).toBe(true)
    expect(isAllowedBrowserUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isAllowedBrowserUrl('http://[::1]:3000')).toBe(true)
  })

  it('blocks private, link-local, metadata, and unspecified hosts', () => {
    expect(isBlockedBrowserHost('192.168.1.20')).toBe(true)
    expect(isBlockedBrowserHost('10.0.0.1')).toBe(true)
    expect(isBlockedBrowserHost('169.254.169.254')).toBe(true)
    expect(isBlockedBrowserHost('0.0.0.0')).toBe(true)
    expect(isBlockedBrowserHost('[fd00::1]')).toBe(true)
    expect(isAllowedBrowserUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
  })
})
