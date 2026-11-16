import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface BrowserSessionTab {
  url: string
  title: string
}

export interface BrowserSessionSnapshot {
  version: 1
  tabs: BrowserSessionTab[]
  activeIndex: number
}

export class BrowserSessionStore {
  constructor(private readonly path: string) {}

  read(): BrowserSessionSnapshot | undefined {
    if (!existsSync(this.path)) return undefined
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<BrowserSessionSnapshot>
      if (value.version !== 1 || !Array.isArray(value.tabs)) return undefined
      const tabs = value.tabs
        .filter((tab): tab is BrowserSessionTab => (
          typeof tab === 'object'
          && tab !== null
          && typeof tab.url === 'string'
          && typeof tab.title === 'string'
        ))
        .slice(0, 8)
      if (tabs.length === 0) return undefined
      const activeIndex = typeof value.activeIndex === 'number' && Number.isInteger(value.activeIndex)
        ? Math.max(0, Math.min(tabs.length - 1, value.activeIndex))
        : 0
      return { version: 1, tabs, activeIndex }
    } catch {
      return undefined
    }
  }

  write(snapshot: BrowserSessionSnapshot): void {
    const temp = `${this.path}.tmp`
    writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.path)
  }
}
