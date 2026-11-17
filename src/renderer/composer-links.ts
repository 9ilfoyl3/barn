const WEB_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+/gi
const TRAILING_PUNCTUATION = /[.,!?;:]/

export interface PromptTextSegment {
  kind: 'text' | 'link'
  text: string
}

function trimUrlPunctuation(candidate: string): string {
  let end = candidate.length
  while (end > 0 && TRAILING_PUNCTUATION.test(candidate[end - 1] ?? '')) end -= 1

  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    let value = candidate.slice(0, end)
    while (value.endsWith(close)) {
      const opens = [...value].filter((character) => character === open).length
      const closes = [...value].filter((character) => character === close).length
      if (closes <= opens) break
      value = value.slice(0, -1)
      end -= 1
    }
  }

  return candidate.slice(0, end)
}

function isWebUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate.startsWith('www.') ? `https://${candidate}` : candidate)
    return parsed.hostname.length > 0
  } catch {
    return false
  }
}

/** Splits composer text into plain text and web-link segments without changing its contents. */
export function promptTextSegments(value: string): PromptTextSegment[] {
  const segments: PromptTextSegment[] = []
  let cursor = 0

  for (const match of value.matchAll(WEB_URL_PATTERN)) {
    const start = match.index
    const rawUrl = match[0]
    if (start === undefined || rawUrl === undefined) continue

    const url = trimUrlPunctuation(rawUrl)
    if (!isWebUrl(url)) continue

    if (start > cursor) segments.push({ kind: 'text', text: value.slice(cursor, start) })
    segments.push({ kind: 'link', text: url })
    cursor = start + url.length
  }

  if (cursor < value.length) segments.push({ kind: 'text', text: value.slice(cursor) })
  return segments
}
