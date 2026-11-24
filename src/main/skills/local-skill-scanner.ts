import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isUtf8 } from 'node:buffer'
import type {
  SkillDiscoveryRoot,
  SkillFileContent,
  SkillFileSummary,
  SkillProvider,
} from '../../shared/models'
import { parseSkillMarkdown } from './skill-markdown'

export interface LocalSkillRootDefinition {
  id: string
  label: string
  provider: SkillProvider
  path: string
}

export interface LocalDiscoveredSkill {
  id: string
  name: string
  description: string
  provider: SkillProvider
  providerLabel: string
  preferenceKey: string
  location: string
  directory: string
  instructionPath: string
  files: SkillFileSummary[]
  updatedAt: string
  fingerprint: string
  semanticHash: string
}

export interface LocalSkillDiscoverySnapshot {
  revision: string
  scannedAt: string
  skills: LocalDiscoveredSkill[]
  roots: SkillDiscoveryRoot[]
  warnings: string[]
}

export interface LocalSkillScannerOptions {
  homeDirectory?: string
  workspaceRoot?: string
  extraRoots?: LocalSkillRootDefinition[]
  includeDefaultRoots?: boolean
  includePluginRoots?: boolean
  pollIntervalMs?: number
  scanTtlMs?: number
  maxDepth?: number
  maxDirectories?: number
  maxFilesPerSkill?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxSkillMarkdownBytes?: number
  now?: () => Date
}

interface ScanState {
  directoriesVisited: number
  warnings: string[]
}

interface SkillFileEntry extends SkillFileSummary {
  absolutePath: string
}

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_DIRECTORIES = 4_000
const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_SKILL_MD_BYTES = 2 * 1024 * 1024
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.tmp',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
])

export class LocalSkillScanner {
  private readonly options: Required<Omit<LocalSkillScannerOptions, 'workspaceRoot' | 'now'>> & {
    workspaceRoot?: string
    now: () => Date
  }
  private snapshot: LocalSkillDiscoverySnapshot = emptySnapshot()
  private lastScanAt = 0
  private scanPromise: Promise<LocalSkillDiscoverySnapshot> | undefined
  private timer: NodeJS.Timeout | undefined
  private notifiedRevision = ''
  private readonly fileIndex = new Map<string, Map<string, SkillFileEntry>>()

  constructor(options: LocalSkillScannerOptions = {}) {
    this.options = {
      homeDirectory: options.homeDirectory ?? homedir(),
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      extraRoots: options.extraRoots ?? [],
      includeDefaultRoots: options.includeDefaultRoots ?? true,
      includePluginRoots: options.includePluginRoots ?? true,
      pollIntervalMs: options.pollIntervalMs ?? 60_000,
      scanTtlMs: options.scanTtlMs ?? 2_000,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxDirectories: options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
      maxFilesPerSkill: options.maxFilesPerSkill ?? DEFAULT_MAX_FILES,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      maxSkillMarkdownBytes: options.maxSkillMarkdownBytes ?? DEFAULT_MAX_SKILL_MD_BYTES,
      now: options.now ?? (() => new Date()),
    }
  }

  getSnapshot(): LocalSkillDiscoverySnapshot {
    return this.snapshot
  }

  async scan(force = false): Promise<LocalSkillDiscoverySnapshot> {
    if (!force && Date.now() - this.lastScanAt < this.options.scanTtlMs) return this.snapshot
    if (this.scanPromise !== undefined) return this.scanPromise
    this.scanPromise = this.performScan()
      .then((next) => {
        this.snapshot = next
        this.lastScanAt = Date.now()
        return next
      })
      .finally(() => {
        this.scanPromise = undefined
      })
    return this.scanPromise
  }

  start(onChange: (snapshot: LocalSkillDiscoverySnapshot) => void): void {
    if (this.timer !== undefined || this.options.pollIntervalMs <= 0) return
    this.notifiedRevision = this.snapshot.revision
    this.timer = setInterval(() => {
      void this.scan(true).then((next) => {
        if (next.revision === this.notifiedRevision) return
        this.notifiedRevision = next.revision
        onChange(next)
      }).catch(() => undefined)
    }, Math.max(5_000, this.options.pollIntervalMs))
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  async readFile(skillId: string, path: string, maxBytes = 2 * 1024 * 1024): Promise<SkillFileContent> {
    const normalizedPath = normalizeRelativePath(path)
    if (normalizedPath === undefined) throw new Error('Invalid skill file path')
    const skill = this.snapshot.skills.find((entry) => entry.id === skillId)
    if (skill === undefined) throw new Error(`Unknown local skill: ${skillId}`)
    const entry = normalizedPath === 'SKILL.md'
      ? {
          path: 'SKILL.md',
          absolutePath: skill.instructionPath,
          size: 0,
          mediaType: 'text/markdown',
        }
      : this.fileIndex.get(skillId)?.get(normalizedPath)
    if (entry === undefined) throw new Error(`Unknown skill file: ${normalizedPath}`)

    const target = await realpath(entry.absolutePath)
    if (!isInside(skill.directory, target)) throw new Error('Skill file escapes its source folder')
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`Not a file: ${normalizedPath}`)
    if (info.size > maxBytes) throw new Error(`Skill file is larger than ${formatBytes(maxBytes)}`)
    const bytes = await readFile(target)
    const binary = !isUtf8(bytes)
    return {
      path: normalizedPath,
      size: info.size,
      mediaType: mediaTypeForPath(target),
      ...(binary ? {} : { text: bytes.toString('utf8') }),
      truncated: false,
      binary,
    }
  }

  async readInstructions(skillId: string): Promise<string> {
    const file = await this.readFile(skillId, 'SKILL.md', this.options.maxSkillMarkdownBytes)
    if (file.binary || file.text === undefined) throw new Error('SKILL.md is not valid UTF-8 text')
    return file.text
  }

  private async performScan(): Promise<LocalSkillDiscoverySnapshot> {
    const warnings: string[] = []
    const roots = await this.resolveRoots(warnings)
    const state: ScanState = { directoriesVisited: 0, warnings }
    const rootStatuses: SkillDiscoveryRoot[] = []
    const discovered: LocalDiscoveredSkill[] = []
    this.fileIndex.clear()

    for (const root of roots) {
      let rootInfo
      try {
        rootInfo = await stat(root.path)
      } catch {
        rootStatuses.push({
          id: root.id,
          label: root.label,
          provider: root.provider,
          path: root.path,
          available: false,
          skillCount: 0,
        })
        continue
      }
      if (!rootInfo.isDirectory()) {
        rootStatuses.push({
          id: root.id,
          label: root.label,
          provider: root.provider,
          path: root.path,
          available: false,
          skillCount: 0,
          error: 'Skill root is not a directory',
        })
        continue
      }

      try {
        const rootReal = await realpath(root.path)
        const found = await this.walkSkills(root, rootReal, state)
        rootStatuses.push({
          id: root.id,
          label: root.label,
          provider: root.provider,
          path: root.path,
          available: true,
          skillCount: found.length,
        })
        discovered.push(...found)
      } catch (error) {
        const message = errorMessage(error)
        warnings.push(`${root.label}: ${message}`)
        rootStatuses.push({
          id: root.id,
          label: root.label,
          provider: root.provider,
          path: root.path,
          available: false,
          skillCount: 0,
          error: message,
        })
      }
    }

    const byDirectory = new Map<string, LocalDiscoveredSkill>()
    for (const skill of discovered) {
      if (!byDirectory.has(skill.directory)) {
        byDirectory.set(skill.directory, skill)
        this.fileIndex.set(skill.id, new Map(skill.files.map((file) => [
          file.path,
          { ...file, absolutePath: join(skill.directory, ...file.path.split('/')) },
        ])))
      }
    }

    const byContent = new Map<string, LocalDiscoveredSkill>()
    for (const skill of byDirectory.values()) {
      const key = `${skill.name.toLocaleLowerCase()}:${skill.semanticHash}`
      if (!byContent.has(key)) byContent.set(key, skill)
    }

    const skills = [...byContent.values()].toSorted((left, right) => (
      providerOrder(left.provider) - providerOrder(right.provider)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      || left.id.localeCompare(right.id)
    ))
    const revision = hashJson(skills.map((skill) => [skill.id, skill.fingerprint]))
    return {
      revision,
      scannedAt: this.options.now().toISOString(),
      skills,
      roots: rootStatuses,
      warnings: [...new Set(warnings)].slice(0, 100),
    }
  }

  private async resolveRoots(warnings: string[]): Promise<LocalSkillRootDefinition[]> {
    const roots: LocalSkillRootDefinition[] = []
    if (this.options.includeDefaultRoots) {
      const home = resolve(this.options.homeDirectory)
      roots.push(
        { id: 'agents', label: 'Agents', provider: 'agents', path: join(home, '.agents', 'skills') },
        { id: 'codex', label: 'Codex', provider: 'codex', path: join(home, '.codex', 'skills') },
        { id: 'claude', label: 'Claude', provider: 'claude', path: join(home, '.claude', 'skills') },
      )
      if (this.options.workspaceRoot !== undefined) {
        roots.push(
          {
            id: 'workspace-agents',
            label: 'Workspace · Agents',
            provider: 'workspace',
            path: join(this.options.workspaceRoot, '.agents', 'skills'),
          },
          {
            id: 'workspace-claude',
            label: 'Workspace · Claude',
            provider: 'workspace',
            path: join(this.options.workspaceRoot, '.claude', 'skills'),
          },
        )
      }
      if (this.options.includePluginRoots) {
        roots.push(...await discoverPluginRoots(this.options.homeDirectory, warnings))
      }
    }
    roots.push(...this.options.extraRoots)

    const seen = new Set<string>()
    return roots.filter((root) => {
      const key = resolve(root.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private async walkSkills(
    root: LocalSkillRootDefinition,
    rootReal: string,
    state: ScanState,
  ): Promise<LocalDiscoveredSkill[]> {
    const queue: Array<{ directory: string; depth: number }> = [{ directory: rootReal, depth: 0 }]
    const discovered: LocalDiscoveredSkill[] = []
    const seenDirectories = new Set<string>()

    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) break
      if (state.directoriesVisited >= this.options.maxDirectories) {
        state.warnings.push(`${root.label}: stopped after ${this.options.maxDirectories} directories`)
        break
      }
      state.directoriesVisited++

      let entries
      try {
        entries = await readdir(next.directory, { withFileTypes: true })
      } catch (error) {
        state.warnings.push(`${root.label}/${relative(rootReal, next.directory)}: ${errorMessage(error)}`)
        continue
      }

      const skillFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md')
      if (skillFiles.length > 1) {
        state.warnings.push(`${join(rootReal, relative(rootReal, next.directory))}: multiple SKILL.md files`)
      } else if (skillFiles.length === 1) {
        try {
          const skill = await this.readSkillDirectory(root, rootReal, next.directory, skillFiles[0]!.name, state)
          if (skill !== undefined) discovered.push(skill)
        } catch (error) {
          state.warnings.push(`${relative(rootReal, next.directory) || basename(next.directory)}: ${errorMessage(error)}`)
        }
      }

      if (next.depth >= this.options.maxDepth) {
        if (entries.some((entry) => entry.isDirectory())) {
          state.warnings.push(`${root.label}: stopped at maximum scan depth ${this.options.maxDepth}`)
        }
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (ignoredDirectory(entry.name, root, next.directory)) continue
        const child = join(next.directory, entry.name)
        let childReal: string
        try {
          childReal = await realpath(child)
        } catch {
          continue
        }
        if (!isInside(rootReal, childReal) || seenDirectories.has(childReal)) continue
        seenDirectories.add(childReal)
        queue.push({ directory: childReal, depth: next.depth + 1 })
      }
    }
    return discovered
  }

  private async readSkillDirectory(
    root: LocalSkillRootDefinition,
    rootReal: string,
    directory: string,
    skillFileName: string,
    state: ScanState,
  ): Promise<LocalDiscoveredSkill | undefined> {
    const directoryReal = await realpath(directory)
    if (!isInside(rootReal, directoryReal)) {
      state.warnings.push(`${root.label}: skipped a skill outside its root`)
      return undefined
    }
    const skillPath = join(directoryReal, skillFileName)
    if (!isInside(directoryReal, await realpath(skillPath))) {
      state.warnings.push(`${relative(rootReal, directory)}: SKILL.md points outside its skill folder`)
      return undefined
    }
    const info = await stat(skillPath)
    if (info.size > this.options.maxSkillMarkdownBytes) {
      throw new Error(`SKILL.md is larger than ${formatBytes(this.options.maxSkillMarkdownBytes)}`)
    }
    const bytes = await readFile(skillPath)
    if (!isUtf8(bytes)) throw new Error('SKILL.md is not valid UTF-8 text')
    const relativeDirectory = toPosix(relative(rootReal, directoryReal))
    const parsed = parseSkillMarkdown(bytes.toString('utf8'), basename(directoryReal))
    const resources = await this.readResources(directoryReal, state)
    const relativeKey = relativeDirectory.length === 0 ? basename(directoryReal) : relativeDirectory
    const slug = relativeKey.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'skill'
    const idHash = sha256(relativeKey).slice(0, 8)
    const id = `local:${root.id}:${slug}:${idHash}`
    const fingerprint = sha256([
      bytes,
      ...resources.map((file) => `${file.path}:${file.size}`),
      String(info.mtimeMs),
    ].join('\n'))
    const semanticHash = sha256([
      bytes,
      ...resources.map((file) => `${file.path}:${file.size}`),
    ].join('\n'))
    return {
      id,
      name: parsed.name,
      description: parsed.description,
      provider: root.provider,
      providerLabel: root.label,
      preferenceKey: `${root.id}:${relativeKey}`,
      location: skillPath,
      directory: directoryReal,
      instructionPath: skillPath,
      files: resources,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      fingerprint,
      semanticHash,
    }
  }

  private async readResources(directory: string, state: ScanState): Promise<SkillFileSummary[]> {
    const files: SkillFileSummary[] = []
    const queue: Array<{ directory: string; depth: number }> = [{ directory, depth: 0 }]
    let totalBytes = 0
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) break
      if (next.depth > this.options.maxDepth) continue
      let entries
      try {
        entries = await readdir(next.directory, { withFileTypes: true })
      } catch (error) {
        state.warnings.push(`${relative(directory, next.directory)}: ${errorMessage(error)}`)
        continue
      }
      for (const entry of entries) {
        if (files.length >= this.options.maxFilesPerSkill) {
          state.warnings.push(`${basename(directory)}: resource limit reached (${this.options.maxFilesPerSkill} files)`)
          return files
        }
        const absolutePath = join(next.directory, entry.name)
        if (entry.isDirectory()) {
          if (!ignoredDirectory(entry.name, undefined, next.directory) && !(await hasSkillManifest(absolutePath))) {
            queue.push({ directory: absolutePath, depth: next.depth + 1 })
          }
          continue
        }
        if (entry.isSymbolicLink()) {
          try {
            const target = await realpath(absolutePath)
            if (!isInside(directory, target) || !(await stat(target)).isFile()) {
              state.warnings.push(`${basename(directory)}: skipped an external symbolic link ${entry.name}`)
              continue
            }
          } catch {
            continue
          }
        } else if (!entry.isFile()) {
          continue
        }
        const target = await realpath(absolutePath)
        if (!isInside(directory, target)) continue
        if (relative(directory, target).toLowerCase() === 'skill.md') continue
        const info = await stat(target)
        if (!info.isFile()) continue
        if (info.size > this.options.maxFileBytes) {
          state.warnings.push(`${basename(directory)}: skipped oversized resource ${entry.name}`)
          continue
        }
        totalBytes += info.size
        if (totalBytes > this.options.maxTotalBytes) {
          state.warnings.push(`${basename(directory)}: resource size limit reached`)
          return files
        }
        files.push({
          path: toPosix(relative(directory, target)),
          size: info.size,
          mediaType: mediaTypeForPath(target),
        })
      }
    }
    return files.toSorted((left, right) => left.path.localeCompare(right.path))
  }
}

export function parseSkillRootList(value: string | undefined, delimiter: string): LocalSkillRootDefinition[] {
  if (value === undefined || value.trim().length === 0) return []
  let paths: string[]
  if (value.trimStart().startsWith('[')) {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
      throw new Error('BARN_SKILL_ROOTS must be a JSON string array or a path list')
    }
    paths = parsed
  } else if (value.trimStart().startsWith('{')) {
    throw new Error('BARN_SKILL_ROOTS must be a JSON string array or a path list')
  } else {
    paths = value.split(delimiter)
  }
  return paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path, index) => ({
      id: `custom-${index + 1}`,
      label: basename(resolve(path)) || `Custom ${index + 1}`,
      provider: 'custom' as const,
      path: resolve(path),
    }))
}

async function hasSkillManifest(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md')
  } catch {
    return false
  }
}

async function discoverPluginRoots(
  homeDirectory: string,
  warnings: string[],
): Promise<LocalSkillRootDefinition[]> {
  return [
    ...await discoverCodexPluginRoots(homeDirectory, warnings),
    ...await discoverClaudePluginRoots(homeDirectory),
  ]
}

async function discoverCodexPluginRoots(
  homeDirectory: string,
  warnings: string[],
): Promise<LocalSkillRootDefinition[]> {
  const codexHome = join(resolve(homeDirectory), '.codex')
  const configPath = join(codexHome, 'config.toml')
  const cacheRoot = join(codexHome, 'plugins', 'cache')
  let config: string
  try {
    config = await readFile(configPath, 'utf8')
  } catch {
    return []
  }
  const enabled = enabledPlugins(config)
  if (enabled.size === 0) return []

  const manifests: Array<{ marketplace: string; manifest: PluginManifest; modified: number }> = []
  await walkPluginManifests(cacheRoot, async (path, marketplace, modified) => {
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      const manifest = parsePluginManifest(raw)
      if (manifest !== undefined) manifests.push({ marketplace, manifest: { ...manifest, path }, modified })
    } catch {
      warnings.push(`Codex plugin manifest is unreadable: ${path}`)
    }
  })

  const selected = new Map<string, { marketplace: string; manifest: PluginManifest; modified: number }>()
  for (const candidate of manifests) {
    const key = `${candidate.marketplace}/${candidate.manifest.name}`
    if (!enabled.has(`${candidate.manifest.name}@${candidate.marketplace}`)) continue
    const current = selected.get(key)
    if (current === undefined || candidate.modified > current.modified) selected.set(key, candidate)
  }

  const roots: LocalSkillRootDefinition[] = []
  for (const [key, candidate] of selected) {
    const pluginRoot = dirname(dirname(candidate.manifest.path))
    const skillsPath = await resolvePluginSkillsPath(pluginRoot, candidate.manifest)
    if (skillsPath === undefined) continue
    roots.push({
      id: `codex-plugin-${sanitizeId(key)}`,
      label: `${candidate.manifest.displayName ?? candidate.manifest.name} · Codex plugin`,
      provider: 'plugin',
      path: skillsPath,
    })
  }
  return roots
}

async function discoverClaudePluginRoots(
  homeDirectory: string,
): Promise<LocalSkillRootDefinition[]> {
  const pluginHome = join(resolve(homeDirectory), '.claude', 'plugins')
  let installed: unknown
  try {
    installed = JSON.parse(await readFile(join(pluginHome, 'installed_plugins.json'), 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(installed) || !isRecord(installed.plugins)) return []

  const roots: LocalSkillRootDefinition[] = []
  for (const [id, value] of Object.entries(installed.plugins)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.installPath !== 'string') continue
      const installPath = resolve(entry.installPath)
      let manifest: Omit<PluginManifest, 'path'> | undefined
      for (const directory of ['.claude-plugin', '.codex-plugin']) {
        try {
          const raw: unknown = JSON.parse(await readFile(join(installPath, directory, 'plugin.json'), 'utf8'))
          manifest = parsePluginManifest(raw)
          if (manifest !== undefined) break
        } catch {
          // Try the other manifest layout.
        }
      }
      const fallbackName = id.split('@')[0] ?? id
      const skillsPath = await resolvePluginSkillsPath(installPath, manifest ?? { name: fallbackName })
      if (skillsPath === undefined) continue
      roots.push({
        id: `claude-plugin-${sanitizeId(id)}`,
        label: `${manifest?.displayName ?? manifest?.name ?? fallbackName} · Claude plugin`,
        provider: 'plugin',
        path: skillsPath,
      })
    }
  }
  return roots
}

interface PluginManifest {
  name: string
  displayName?: string
  skills?: string
  path: string
}

function parsePluginManifest(value: unknown): Omit<PluginManifest, 'path'> | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const displayName = isRecord(value.interface) && typeof value.interface.displayName === 'string'
    ? value.interface.displayName
    : undefined
  return {
    name: value.name,
    ...(typeof value.skills === 'string' ? { skills: value.skills } : {}),
    ...(displayName === undefined ? {} : { displayName }),
  }
}

async function resolvePluginSkillsPath(
  pluginRoot: string,
  manifest: Pick<PluginManifest, 'skills'>,
): Promise<string | undefined> {
  const candidates = manifest.skills === undefined
    ? ['skills', '.claude/skills', '.agents/skills']
    : [manifest.skills]
  for (const candidate of candidates) {
    const skillsPath = resolve(pluginRoot, candidate)
    if (!isInside(pluginRoot, skillsPath)) continue
    try {
      if ((await stat(skillsPath)).isDirectory()) return skillsPath
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined
}

async function walkPluginManifests(
  cacheRoot: string,
  visit: (path: string, marketplace: string, modified: number) => Promise<void>,
): Promise<void> {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: cacheRoot, depth: 0 }]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    if (next.depth > 6) continue
    let entries
    try {
      entries = await readdir(next.directory, { withFileTypes: true })
    } catch {
      continue
    }
    if (next.depth <= 4) {
      for (const manifestDirectory of ['.codex-plugin', '.claude-plugin']) {
        if (!entries.some((entry) => entry.isDirectory() && entry.name === manifestDirectory)) continue
        const manifestPath = join(next.directory, manifestDirectory, 'plugin.json')
        try {
          const info = await stat(manifestPath)
          const relativePath = relative(cacheRoot, next.directory)
          const marketplace = relativePath.split(sep)[0] ?? ''
          await visit(manifestPath, marketplace, info.mtimeMs)
        } catch {
          // The plugin may use another marketplace manifest layout.
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      queue.push({ directory: join(next.directory, entry.name), depth: next.depth + 1 })
    }
  }
}

function enabledPlugins(config: string): Set<string> {
  const enabled = new Set<string>()
  let section: string | undefined
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const plugin = /^\[plugins\."([^"]+)"\]$/u.exec(line)?.[1]
    if (plugin !== undefined) {
      section = plugin
      continue
    }
    if (line.startsWith('[')) {
      section = undefined
      continue
    }
    if (section !== undefined && /^enabled\s*=\s*true\s*(?:#.*)?$/u.test(line)) enabled.add(section)
    if (section !== undefined && /^enabled\s*=\s*false/u.test(line)) enabled.delete(section)
  }
  return enabled
}

function ignoredDirectory(name: string, root: LocalSkillRootDefinition | undefined, parent: string): boolean {
  if (IGNORED_DIRECTORIES.has(name)) return true
  if (name.startsWith('.')) return true
  if (root?.provider === 'codex' && name === '.system' && basename(parent) === 'skills') return true
  return false
}

function normalizeRelativePath(path: string): string | undefined {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) return undefined
  const normalized = path.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value.length === 0 || (!value.startsWith('..') && !isAbsolute(value))
}

function providerOrder(provider: SkillProvider): number {
  return ({ agents: 0, codex: 1, claude: 2, plugin: 3, workspace: 4, custom: 5, barn: 6 })[provider]
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.markdown': return 'text/markdown'
    case '.json': return 'application/json'
    case '.yaml':
    case '.yml': return 'application/yaml'
    case '.js':
    case '.mjs':
    case '.cjs': return 'text/javascript'
    case '.ts':
    case '.tsx': return 'text/typescript'
    case '.py': return 'text/x-python'
    case '.sh': return 'text/x-shellscript'
    case '.html':
    case '.htm': return 'text/html'
    case '.css': return 'text/css'
    case '.csv': return 'text/csv'
    case '.txt': return 'text/plain'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.pdf': return 'application/pdf'
    default: return 'application/octet-stream'
  }
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'plugin'
}

function emptySnapshot(): LocalSkillDiscoverySnapshot {
  return { revision: 'local:empty', scannedAt: '', skills: [], roots: [], warnings: [] }
}

function hashJson(value: unknown): string {
  return `local:${sha256(JSON.stringify(value))}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
