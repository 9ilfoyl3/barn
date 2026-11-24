export interface ParsedSkillMarkdown {
  name: string
  description: string
  instructions: string
  activation?: string
}

const MAX_NAME = 120
const MAX_DESCRIPTION = 500

/**
 * Parses the small, portable subset of SKILL.md frontmatter Barn needs for
 * discovery. Unknown YAML is deliberately ignored rather than interpreted.
 */
export function parseSkillMarkdown(content: string, fallbackName: string): ParsedSkillMarkdown {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim()
  if (normalized.length === 0) throw new Error('SKILL.md is empty')

  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized)
  const fields = frontmatter === null ? {} : parseFrontmatter(frontmatter[1] ?? '')
  const instructions = (frontmatter === null ? normalized : normalized.slice(frontmatter[0].length)).trim()
  if (instructions.length === 0) throw new Error('SKILL.md has no instructions')

  const heading = /^#\s+(.+)$/mu.exec(instructions)?.[1]?.trim()
  const fallbackDescription = instructions
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('```')) ?? ''

  const activation = cleanField(fields.activation)
  return {
    name: clip(cleanField(fields.name) || heading || fallbackName, MAX_NAME),
    description: clip(cleanField(fields.description) || fallbackDescription, MAX_DESCRIPTION),
    instructions,
    ...(activation === undefined ? {} : { activation }),
  }
}

export function sanitizeSkillMetadata(value: string, maxLength: number): string {
  return clip(value.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\s+/gu, ' ').trim(), maxLength)
}

function parseFrontmatter(source: string): Record<string, string> {
  const lines = source.split('\n')
  const fields: Record<string, string> = {}
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    if (line.startsWith(' ') || line.startsWith('\t')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    if (!['name', 'description', 'summary', 'activation'].includes(key)) continue
    const rawValue = line.slice(separator + 1).trim()
    if (/^[|>][-+]?$/u.test(rawValue)) {
      const block: string[] = []
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? ''
        if (next.trim().length > 0 && !next.startsWith(' ') && !next.startsWith('\t')) break
        index++
        if (next.trim().length > 0) block.push(next.trim())
      }
      fields[key] = rawValue.startsWith('|') ? block.join('\n') : block.join(' ')
      continue
    }
    fields[key] = unquote(rawValue)
  }
  return fields
}

function cleanField(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === undefined || normalized.length === 0 ? undefined : normalized
}

function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value.at(-1)
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value.replace(/\s+#.*$/u, '').trim()
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trimEnd()
}
