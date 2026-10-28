import type { AttachmentDescriptor } from './models'

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i
const UUID_STEM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX_STEM = /^[0-9a-f]{24,}$/i

/**
 * Resolve a user-facing attachment name while never exposing internal storage IDs.
 * Stored files are prefixed with a UUID, followed by the original filename.
 */
export function attachmentDisplayName(file: Pick<AttachmentDescriptor, 'name' | 'path'>): string {
  const candidates = [file.name, fileNameFromPath(file.path)]
  for (const candidate of candidates) {
    const displayName = humanReadableName(candidate)
    if (displayName !== undefined) return displayName
  }

  const extension = candidates
    .map((candidate) => candidate.trim().match(/(\.[a-z0-9]{1,12})$/i)?.[1])
    .find((value) => value !== undefined)
  return extension === undefined ? 'Attachment' : `Attachment${extension.toLowerCase()}`
}

/** Keep the original filename recoverable in the internal storage path. */
export function storedAttachmentFileName(id: string, originalName: string): string {
  const safeName = sanitizeFileName(fileNameFromPath(originalName)).trim()
  const extension = safeName.match(/(\.[^.]{1,12})$/)?.[1] ?? ''
  const stem = extension.length > 0 ? safeName.slice(0, -extension.length) : safeName
  const clippedStem = Array.from(stem).slice(0, 160).join('')
  const fallbackStem = clippedStem.length > 0 ? clippedStem : 'attachment'
  return `${id}-${fallbackStem}${extension}`
}

function humanReadableName(value: string): string | undefined {
  const name = fileNameFromPath(value.trim()).replace(UUID_PREFIX, '').trim()
  if (name.length === 0 || name === '.' || name === '..') return undefined
  const stem = name.replace(/\.[^.]+$/, '')
  if (UUID_STEM.test(stem) || LONG_HEX_STEM.test(stem)) return undefined
  return name
}

function fileNameFromPath(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value
}

function sanitizeFileName(value: string): string {
  const unsupported = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
  return Array.from(value).map((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || unsupported.has(character) ? '_' : character
  }).join('')
}
