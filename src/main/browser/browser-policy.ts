import { isIP } from 'node:net'

const allowedProtocols = new Set(['http:', 'https:'])

export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') return true
  try {
    const url = new URL(rawUrl)
    if (!allowedProtocols.has(url.protocol)) return false
    return !isBlockedBrowserHost(url.hostname)
  } catch {
    return false
  }
}

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()
  if (value.length === 0) return 'about:blank'

  let candidate = value
  if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) candidate = `https://${candidate}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('Enter a valid web address.')
  }
  if (!isAllowedBrowserUrl(parsed.toString())) {
    throw new Error(`Browser address is not allowed: ${parsed.hostname || parsed.protocol}`)
  }
  return parsed.toString()
}

export function isBlockedBrowserHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host === '127.0.0.1' || host === '::1') return false
  if (host === '0.0.0.0' || host === '::') return true

  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return a === 0
  }

  if (isIP(host) === 6) {
    return host.startsWith('fc')
      || host.startsWith('fd')
      || host.startsWith('fe8')
      || host.startsWith('fe9')
      || host.startsWith('fea')
      || host.startsWith('feb')
      || host === '::'
  }

  return false
}
