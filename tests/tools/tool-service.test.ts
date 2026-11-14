import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolService } from '../../src/main/tools/tool-service'
import type { ShellService } from '../../src/main/sandbox/shell-service'

async function createService(): Promise<{
  service: ToolService
  workspace: string
  output: string
  temp: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'barn-tools-'))
  const workspace = join(root, 'workspace')
  const output = join(root, 'output')
  const temp = join(root, 'temp')
  await Promise.all([mkdir(workspace), mkdir(output), mkdir(temp)])
  return {
    service: new ToolService({
      workspaceRoot: workspace,
      outputRoot: output,
      privateTempRoot: temp,
      shell: { run: vi.fn() } as unknown as ShellService,
    }),
    workspace,
    output,
    temp,
  }
}

describe('ToolService', () => {
  it('reads text with line ranges and metadata', async () => {
    const { service, workspace } = await createService()
    await writeFile(join(workspace, 'notes.txt'), 'one\ntwo\nthree\nfour')

    const result = await service.execute('read_file', {
      path: 'notes.txt',
      startLine: 2,
      lineCount: 2,
    })

    expect(result.content).toEqual([{ type: 'text', text: '2: two\n3: three' }])
    expect(result.details).toMatchObject({ totalLines: 4, truncated: true })
  })

  it('uses a selected working directory as the default tool root', async () => {
    const { service, workspace } = await createService()
    const root = dirname(workspace)
    const working = join(root, 'selected-working-directory')
    await mkdir(working)
    await writeFile(join(working, 'outside.txt'), 'selected directory content')

    await expect(service.execute('read_file', { path: 'outside.txt' }))
      .resolves.toMatchObject({ isError: true })
    const result = await service.execute('read_file', { path: 'outside.txt' }, { workingDirectory: working })
    expect(result).toMatchObject({
      content: [{ type: 'text', text: '1: selected directory content' }],
    })
  })

  it('rejects paths outside managed roots and secret files', async () => {
    const { service, workspace } = await createService()
    const outside = join(tmpdir(), 'barn-outside-secret.txt')
    await writeFile(outside, 'secret').catch(() => undefined)
    await writeFile(join(workspace, '.env'), 'TOKEN=secret')

    await expect(service.execute('read_file', { path: outside }))
      .resolves.toMatchObject({ isError: true })
    await expect(service.execute('read_file', { path: '.env' }))
      .resolves.toMatchObject({ isError: true })
  })

  it('reports binary files rather than decoding them as text', async () => {
    const { service, workspace } = await createService()
    await writeFile(join(workspace, 'roster.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))

    const result = await service.execute('read_file', { path: 'roster.pdf' })

    expect(result.content[0]?.type).toBe('text')
    expect(result.details).toMatchObject({ binary: true })
  })

  it('returns image content for supported image files', async () => {
    const { service, workspace } = await createService()
    await writeFile(join(workspace, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await service.execute('view_image', { path: 'photo.png' })

    expect(result.content).toEqual([{
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
    }])
  })

  it('searches text files with bounded results', async () => {
    const { service, workspace } = await createService()
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'notes.txt'), 'alpha beta\nbeta gamma\nalpha beta')

    const result = await service.execute('search_files', {
      path: '.',
      query: 'alpha',
    })

    expect(result.content).toEqual([{
      type: 'text',
      text: 'docs/notes.txt:1:alpha beta\ndocs/notes.txt:3:alpha beta',
    }])
  })

  it('reports invalid regular expressions as a tool error', async () => {
    const { service } = await createService()

    const result = await service.execute('search_files', {
      path: '.',
      query: '[',
      literal: false,
    })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Invalid regular expression') })
  })

  it('supports regex, globs, case folding, and context around matches', async () => {
    const { service, workspace } = await createService()
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'app.ts'), 'first\nERROR code 42\nlast\n')
    await writeFile(join(workspace, 'src', 'notes.md'), 'error code 42\n')

    const result = await service.execute('search_files', {
      path: '.',
      query: 'error\\s+code\\s+\\d+',
      literal: false,
      ignoreCase: true,
      glob: 'src/**/*.ts',
      context: 1,
    })

    expect(result).toMatchObject({
      content: [{ type: 'text', text: `src/app.ts:1:first\nsrc/app.ts:2:ERROR code 42\nsrc/app.ts:3:last` }],
      details: { matches: 1, matchingFiles: 1 },
    })
  })

  it('skips gitignored, generated, and sensitive files during content search', async () => {
    const { service, workspace } = await createService()
    await mkdir(join(workspace, 'ignored'), { recursive: true })
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, '.gitignore'), 'ignored/\n*.log\n')
    await writeFile(join(workspace, 'ignored', 'notes.txt'), 'needle\n')
    await writeFile(join(workspace, 'debug.log'), 'needle\n')
    await writeFile(join(workspace, '.env'), 'TOKEN=needle\n')
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'needle\n')

    const result = await service.execute('search_files', { path: '.', query: 'needle' })

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'No matches for "needle"' }],
      details: { matches: 0, skipped: expect.any(Number) },
    })
  })

  it('finds files by glob without traversing ignored directories', async () => {
    const { service, workspace } = await createService()
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'ignored'), { recursive: true })
    await writeFile(join(workspace, '.gitignore'), 'ignored/\n')
    await writeFile(join(workspace, 'src', 'app.ts'), 'export {}\n')
    await writeFile(join(workspace, 'src', 'readme.md'), '# Notes\n')
    await writeFile(join(workspace, 'ignored', 'hidden.ts'), 'export {}\n')

    const result = await service.execute('find_files', {
      path: '.',
      pattern: '**/*.ts',
    })

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'src/app.ts' }],
      details: { matches: 1 },
    })
  })

  it('writes new text files inside the managed workspace and creates parents', async () => {
    const { service, workspace } = await createService()

    const result = await service.execute('write_file', {
      path: 'drafts/report.txt',
      content: 'first draft\n',
    })

    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Successfully wrote') }],
      details: { created: true, bytes: 12 },
    })
    expect(await readFile(join(workspace, 'drafts', 'report.txt'), 'utf8')).toBe('first draft\n')
    expect(await readdir(join(workspace, 'drafts'))).toEqual(['report.txt'])
  })

  it('rejects writes outside managed roots and to sensitive paths', async () => {
    const { service } = await createService()

    await expect(service.execute('write_file', { path: '../escape.txt', content: 'no' }))
      .resolves.toMatchObject({ isError: true })
    await expect(service.execute('write_file', { path: '.env', content: 'TOKEN=no' }))
      .resolves.toMatchObject({ isError: true })
  })

  it('applies multiple exact edits and preserves CRLF line endings', async () => {
    const { service, workspace } = await createService()
    const path = join(workspace, 'notes.txt')
    await writeFile(path, 'title\r\nold one\r\nmiddle\r\nold two\r\n')

    const result = await service.execute('edit_file', {
      path: 'notes.txt',
      edits: [
        { oldText: 'old one', newText: 'new one\ncontinued' },
        { oldText: 'old two', newText: 'new two' },
      ],
    })

    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Successfully applied 2 edits') }],
      details: { edits: 2 },
    })
    expect(await readFile(path, 'utf8')).toBe('title\r\nnew one\r\ncontinued\r\nmiddle\r\nnew two\r\n')
  })

  it('preserves a UTF-8 BOM while editing', async () => {
    const { service, workspace } = await createService()
    const path = join(workspace, 'bom.txt')
    await writeFile(path, '\uFEFFalpha\n')

    await service.execute('edit_file', {
      path: 'bom.txt',
      edits: [{ oldText: 'alpha', newText: 'beta' }],
    })

    expect(await readFile(path, 'utf8')).toBe('\uFEFFbeta\n')
  })

  it('rejects overlapping edits before writing', async () => {
    const { service, workspace } = await createService()
    const path = join(workspace, 'overlap.txt')
    await writeFile(path, 'abcdef')

    const result = await service.execute('edit_file', {
      path: 'overlap.txt',
      edits: [
        { oldText: 'abc', newText: 'x' },
        { oldText: 'cde', newText: 'y' },
      ],
    })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('overlap') })
    expect(await readFile(path, 'utf8')).toBe('abcdef')
  })

  it('rejects writes through a symlink that escapes the managed workspace', async () => {
    const { service, workspace } = await createService()
    const outside = await mkdtemp(join(tmpdir(), 'barn-tools-outside-'))
    await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await service.execute('write_file', {
      path: 'linked/escape.txt',
      content: 'should not exist',
    })

    expect(result).toMatchObject({ isError: true })
    await expect(readFile(join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects ambiguous or non-matching edits without changing the file', async () => {
    const { service, workspace } = await createService()
    const path = join(workspace, 'duplicate.txt')
    await writeFile(path, 'same\nsame\n')

    const ambiguous = await service.execute('edit_file', {
      path: 'duplicate.txt',
      edits: [{ oldText: 'same', newText: 'changed' }],
    })
    expect(ambiguous).toMatchObject({ isError: true })
    expect(ambiguous.content[0]).toMatchObject({ text: expect.stringContaining('must be unique') })
    expect(await readFile(path, 'utf8')).toBe('same\nsame\n')

    const missing = await service.execute('edit_file', {
      path: 'duplicate.txt',
      edits: [{ oldText: 'missing', newText: 'changed' }],
    })
    expect(missing).toMatchObject({ isError: true })
    expect(await readFile(path, 'utf8')).toBe('same\nsame\n')
  })

  it('lists entries relative to the requested directory with a bounded count', async () => {
    const { service, workspace } = await createService()
    await mkdir(join(workspace, 'docs', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'docs', 'notes.txt'), 'notes\n')
    await writeFile(join(workspace, 'docs', 'readme.txt'), 'readme\n')

    const result = await service.execute('list_dir', {
      path: 'docs',
      depth: 1,
      maxEntries: 2,
    })

    expect(result.content).toEqual([{ type: 'text', text: 'nested/\nnotes.txt\n\n[2 entries limit reached]' }])
    expect(result.details).toMatchObject({ entries: 2, truncated: true })
  })
})
