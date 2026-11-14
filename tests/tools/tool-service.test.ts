import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('rejects paths outside managed roots and secret files', async () => {
    const { service, workspace } = await createService()
    await writeFile('/tmp/barn-outside-secret.txt', 'secret').catch(() => undefined)
    await writeFile(join(workspace, '.env'), 'TOKEN=secret')

    await expect(service.execute('read_file', { path: '/tmp/barn-outside-secret.txt' }))
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
})
