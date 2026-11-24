import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalSkillScanner, parseSkillRootList } from '../../src/main/skills/local-skill-scanner'

async function skill(root: string, id: string, frontmatter: string, body: string) {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `${frontmatter}\n\n${body}`)
  return directory
}

describe('LocalSkillScanner', () => {
  it('discovers standard skill roots, nested packages, and resources', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-home-'))
    const agents = join(home, '.agents', 'skills')
    const codex = join(home, '.codex', 'skills')
    const claude = join(home, '.claude', 'skills')
    const nested = await skill(agents, 'bundle', '---\nname: Research bundle\ndescription: Bundle root.\n---', '# Research bundle')
    await mkdir(join(nested, 'references'), { recursive: true })
    await writeFile(join(nested, 'references', 'guide.md'), '# Guide\n\nUse primary sources.')
    await skill(join(nested, 'skills'), 'deep-research', '---\nname: Deep research\ndescription: Nested workflow.\n---', '# Deep research')
    await skill(codex, 'codex-workflow', '---\nname: Codex workflow\ndescription: Works in Codex.\n---', '# Codex workflow')
    await skill(join(codex, '.system'), 'built-in', '---\nname: Built in\ndescription: Hidden.\n---', '# Hidden')
    await skill(claude, 'claude-workflow', '---\nname: Claude workflow\ndescription: Works in Claude.\n---', '# Claude workflow')

    const scanner = new LocalSkillScanner({ homeDirectory: home, includePluginRoots: false, scanTtlMs: 0 })
    const snapshot = await scanner.scan(true)

    expect(snapshot.skills.map((entry) => entry.name).toSorted()).toEqual([
      'Claude workflow',
      'Codex workflow',
      'Deep research',
      'Research bundle',
    ])
    expect(snapshot.skills.find((entry) => entry.name === 'Research bundle')).toMatchObject({
      provider: 'agents',
      providerLabel: 'Agents',
      files: [expect.objectContaining({ path: 'references/guide.md', mediaType: 'text/markdown' })],
    })
    expect((await scanner.readFile(snapshot.skills.find((entry) => entry.name === 'Research bundle')!.id, 'references/guide.md')).text)
      .toContain('Use primary sources')
    expect(snapshot.roots.find((root) => root.id === 'codex')).toMatchObject({ available: true, skillCount: 1 })
  })

  it('deduplicates the same real skill folder and ignores escaping symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-dedupe-'))
    const agents = join(home, '.agents', 'skills')
    const directory = await skill(agents, 'safe', '---\nname: Safe\ndescription: Safe skill.\n---', '# Safe')
    const outside = await mkdtemp(join(tmpdir(), 'barn-skill-outside-'))
    await writeFile(join(outside, 'secret.md'), 'outside')
    await symlink(join(outside, 'secret.md'), join(directory, 'secret.md'))
    const aliasRoot = join(home, 'alias-root')
    await mkdir(aliasRoot, { recursive: true })
    await symlink(agents, join(aliasRoot, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')

    const scanner = new LocalSkillScanner({
      homeDirectory: home,
      includePluginRoots: false,
      extraRoots: [{ id: 'alias', label: 'Alias', provider: 'custom', path: join(aliasRoot, 'skills') }],
      scanTtlMs: 0,
    })
    const snapshot = await scanner.scan(true)

    expect(snapshot.skills.filter((entry) => entry.name === 'Safe')).toHaveLength(1)
    expect(snapshot.skills[0]?.files).toEqual([])
    expect(snapshot.warnings.join('\n')).toContain('external symbolic link')
  })

  it('deduplicates identical copies across providers but keeps same-name conflicts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-content-dedupe-'))
    const shared = '---\nname: Shared workflow\ndescription: Same copy.\n---\n\n# Shared workflow'
    await skill(join(home, '.agents', 'skills'), 'shared', shared, '')
    await skill(join(home, '.codex', 'skills'), 'shared', shared, '')
    await skill(join(home, '.claude', 'skills'), 'shared', '---\nname: Shared workflow\ndescription: Different copy.\n---', '# Different workflow')

    const scanner = new LocalSkillScanner({ homeDirectory: home, includePluginRoots: false, scanTtlMs: 0 })
    const snapshot = await scanner.scan(true)
    const sharedSkills = snapshot.skills.filter((entry) => entry.name === 'Shared workflow')

    expect(sharedSkills).toHaveLength(2)
    expect(sharedSkills.map((entry) => entry.provider)).toEqual(['agents', 'claude'])
  })

  it('loads skills only from enabled Codex plugins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-plugins-'))
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'config.toml'), [
      '[plugins."demo@marketplace"]',
      'enabled = true',
      '[plugins."disabled@marketplace"]',
      'enabled = false',
    ].join('\n'))
    const enabledRoot = join(home, '.codex', 'plugins', 'cache', 'marketplace', 'demo', '1.0.0')
    const disabledRoot = join(home, '.codex', 'plugins', 'cache', 'marketplace', 'disabled', '1.0.0')
    await mkdir(join(enabledRoot, '.codex-plugin'), { recursive: true })
    await mkdir(join(disabledRoot, '.codex-plugin'), { recursive: true })
    await writeFile(join(enabledRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo',
      skills: './skills/',
      interface: { displayName: 'Demo Plugin' },
    }))
    await writeFile(join(disabledRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'disabled',
      skills: './skills/',
    }))
    await skill(join(enabledRoot, 'skills'), 'demo-skill', '---\nname: Demo skill\ndescription: From a plugin.\n---', '# Demo')
    await skill(join(disabledRoot, 'skills'), 'disabled-skill', '---\nname: Disabled skill\ndescription: Off.\n---', '# Disabled')

    const scanner = new LocalSkillScanner({ homeDirectory: home, scanTtlMs: 0 })
    const snapshot = await scanner.scan(true)

    expect(snapshot.skills.map((entry) => entry.name)).toEqual(['Demo skill'])
    expect(snapshot.skills[0]).toMatchObject({ provider: 'plugin', providerLabel: 'Demo Plugin · Codex plugin' })
  })

  it('loads skills from installed Claude plugins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-claude-plugins-'))
    const installPath = join(home, '.claude', 'plugins', 'cache', 'market', 'claude-demo', 'abc123')
    await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true })
    await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'claude-demo@market': [{ scope: 'user', installPath, version: 'abc123' }],
      },
    }))
    await writeFile(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'claude-demo',
      skills: './skills/',
      interface: { displayName: 'Claude Demo' },
    }))
    await skill(join(installPath, 'skills'), 'claude-plugin-skill', '---\nname: Claude plugin skill\ndescription: Installed in Claude.\n---', '# Claude plugin')

    const scanner = new LocalSkillScanner({ homeDirectory: home, scanTtlMs: 0 })
    const snapshot = await scanner.scan(true)

    expect(snapshot.skills.map((entry) => entry.name)).toEqual(['Claude plugin skill'])
    expect(snapshot.skills[0]).toMatchObject({ provider: 'plugin', providerLabel: 'Claude Demo · Claude plugin' })
  })

  it('refreshes metadata and reports malformed or oversized skills without failing the scan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-refresh-'))
    const root = join(home, '.agents', 'skills')
    const directory = await skill(root, 'change-me', '---\nname: Before\ndescription: First.\n---', '# Before')
    await skill(root, 'empty', '---\nname: Empty\ndescription: Empty.\n---', '')
    await mkdir(join(directory, 'assets'), { recursive: true })
    await writeFile(join(directory, 'assets', 'large.bin'), Buffer.alloc(2_048))
    const scanner = new LocalSkillScanner({
      homeDirectory: home,
      includePluginRoots: false,
      maxFileBytes: 1_024,
      scanTtlMs: 0,
    })
    const first = await scanner.scan(true)
    expect(first.skills.find((entry) => entry.name === 'Before')?.files).toEqual([])
    expect(first.warnings.join('\n')).toContain('oversized resource')

    await writeFile(join(directory, 'SKILL.md'), '---\nname: After\ndescription: Second.\n---\n\n# After')
    const second = await scanner.scan(true)
    expect(second.skills.find((skillEntry) => skillEntry.id === first.skills.find((entry) => entry.name === 'Before')?.id)?.name).toBe('After')
    expect(second.revision).not.toBe(first.revision)
  })

  it('parses configured root lists and rejects malformed JSON', () => {
    const roots = parseSkillRootList(JSON.stringify(['/tmp/one', '/tmp/two']), ':')
    expect(roots.map((root) => root.path)).toEqual(['/tmp/one', '/tmp/two'])
    expect(roots.every((root) => root.provider === 'custom')).toBe(true)
    expect(() => parseSkillRootList('{"bad":true}', ':')).toThrow('BARN_SKILL_ROOTS')
  })

  it('keeps the discovered instruction file case-insensitive', async () => {
    const home = await mkdtemp(join(tmpdir(), 'barn-skill-case-'))
    const root = join(home, '.agents', 'skills')
    const directory = join(root, 'lowercase')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'skill.md'), '---\nname: Lowercase\ndescription: Lowercase manifest.\n---\n\n# Lowercase')
    const scanner = new LocalSkillScanner({ homeDirectory: home, includePluginRoots: false, scanTtlMs: 0 })
    const snapshot = await scanner.scan(true)
    const found = snapshot.skills.find((entry) => entry.name === 'Lowercase')!
    expect(await scanner.readInstructions(found.id)).toContain('# Lowercase')
    expect((await readFile(found.instructionPath, 'utf8')).length).toBeGreaterThan(0)
  })
})
