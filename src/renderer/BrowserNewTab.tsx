import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Globe2, Search, Terminal } from 'lucide-react'
import type { BrowserHistoryEntry } from '../shared/models'
import { Input } from './components/Input'

export type BrowserQuickAction = 'terminal' | 'files'

export interface BrowserNewTabProps {
  history: BrowserHistoryEntry[]
  onNavigate: (url: string) => void | Promise<void>
  onQuickAction: (action: BrowserQuickAction) => void
}

export function BrowserNewTab({ history, onNavigate, onQuickAction }: BrowserNewTabProps) {
  const { t } = useTranslation()
  const [address, setAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)

  async function submit(): Promise<void> {
    const target = browserTarget(address)
    if (submitting || target.length === 0) return
    setSubmitting(true)
    try {
      await onNavigate(target)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="browser-newtab">
      <div
        className="browser-newtab-search-wrap"
        onFocus={() => setSearchFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchFocused(false)
        }}
      >
        <form className="browser-newtab-search" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <Search size={18} aria-hidden="true" />
          <Input
            aria-label={t('browser.address')}
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('browser.searchPlaceholder')}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            appearance="flush"
            density="compact"
          />
        </form>
        {searchFocused && (
          <div className="browser-newtab-suggestions" onMouseDown={(event) => event.preventDefault()}>
            {address.trim().length > 0 && (
              <button className="browser-suggestion search" type="button" onClick={() => void submit()}>
                <Search size={15} />
                <span>{address.trim()}</span>
                <small>{t('browser.searchWeb')}</small>
              </button>
            )}
            {browserHistorySuggestions(address, history).map((entry) => (
              <button
                className="browser-suggestion"
                type="button"
                key={entry.url}
                onClick={() => void onNavigate(entry.url)}
              >
                <Globe2 size={15} />
                <span>{entry.title}</span>
                <small>{hostname(entry.url)}</small>
              </button>
            ))}
            {address.trim().length === 0 && history.length === 0 && (
              <div className="browser-suggestion-empty">{t('browser.noSuggestions')}</div>
            )}
          </div>
        )}
      </div>
      <div className="browser-newtab-section">
        <div className="browser-newtab-heading">
          <span>{t('browser.newTabSection')}</span>
        </div>
        <div className="browser-newtab-grid">
          <button type="button" onClick={() => onQuickAction('terminal')}>
            <span className="browser-newtab-card-icon"><Terminal size={18} /></span>
            <span>{t('browser.terminal')}</span>
          </button>
          <button type="button" onClick={() => onQuickAction('files')}>
            <span className="browser-newtab-card-icon"><Folder size={18} /></span>
            <span>{t('browser.files')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function browserHistorySuggestions(query: string, history: BrowserHistoryEntry[]): Array<{ url: string; title: string }> {
  const normalized = query.trim().toLocaleLowerCase()
  const matches = history.filter((entry) => (
    normalized.length === 0
    || entry.title.toLocaleLowerCase().includes(normalized)
    || entry.url.toLocaleLowerCase().includes(normalized)
  ))
  return matches.slice(0, 6).map(({ url, title }) => ({ url, title }))
}

function hostname(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function browserTarget(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (trimmed.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(trimmed)) {
    return trimmed
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
