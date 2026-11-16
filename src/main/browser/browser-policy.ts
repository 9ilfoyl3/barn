const allowedProtocols = new Set(['http:', 'https:'])

export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') return true
  try {
    return allowedProtocols.has(new URL(rawUrl).protocol)
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
    throw new Error(`Browser protocol is not allowed: ${parsed.protocol}`)
  }
  return parsed.toString()
}
