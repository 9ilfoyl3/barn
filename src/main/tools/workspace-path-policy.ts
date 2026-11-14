const DENIED_FILE_NAMES = new Set([
  '.env',
  'credentials',
  'id_rsa',
  'id_ed25519',
])

const DENIED_DIRECTORY_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.docker',
])

export function isDeniedPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  if (DENIED_FILE_NAMES.has(name) || name.startsWith('.env.')) return true
  if (segments.some((segment) => DENIED_DIRECTORY_SEGMENTS.has(segment))) return true
  if (segments.some((segment) => segment.includes('keychain'))) return true
  return normalized.includes('/.config/gcloud/') || normalized.endsWith('/.config/gcloud')
}

export function isGeneratedDirectory(name: string): boolean {
  return name === '.git' || name === 'node_modules'
}
