import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserSessionStore } from '../../src/main/browser/browser-session-store'

describe('BrowserSessionStore', () => {
  it('round-trips tabs and clamps the active index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-browser-session-'))
    const store = new BrowserSessionStore(join(directory, 'browser-session.json'))
    store.write({
      version: 1,
      tabs: [
        { url: 'https://example.com/', title: 'Example' },
        { url: 'https://example.org/', title: 'Example Org' },
      ],
      activeIndex: 8,
      history: [{ url: 'https://example.com/', title: 'Example', visitedAt: '2026-11-17T00:00:00.000Z' }],
    })
    expect(store.read()).toMatchObject({
      activeIndex: 1,
      history: [{ url: 'https://example.com/', title: 'Example' }],
    })
  })

  it('ignores malformed snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'barn-browser-session-bad-'))
    const path = join(directory, 'browser-session.json')
    await writeFile(path, '{not-json')
    expect(new BrowserSessionStore(path).read()).toBeUndefined()
  })
})
