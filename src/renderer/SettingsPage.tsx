import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArchiveRestore, Folder, LoaderCircle, Search, Settings2, X } from 'lucide-react'
import type { SessionSummary } from '../shared/models'

interface SettingsPageProps {
  sessions: SessionSummary[]
  onUnarchive: (sessionId: string) => Promise<void>
}

interface ArchivedGroup {
  key: string
  label: string
  sessions: SessionSummary[]
}

export function SettingsPage({ sessions, onUnarchive }: SettingsPageProps) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [unarchivingId, setUnarchivingId] = useState<string>()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleSessions = normalizedQuery === ''
    ? sessions
    : sessions.filter((session) => session.title.toLocaleLowerCase().includes(normalizedQuery))
  const groups = groupArchivedSessions(
    visibleSessions,
    t('appSettings.localWorkspace'),
  )

  async function unarchive(sessionId: string): Promise<void> {
    if (unarchivingId !== undefined) return
    setUnarchivingId(sessionId)
    try {
      await onUnarchive(sessionId)
    } finally {
      setUnarchivingId(undefined)
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-page-nav" aria-label={t('appSettings.navLabel')}>
        <div className="settings-page-nav-heading">
          <Settings2 size={16} aria-hidden="true" />
          <span>{t('appSettings.title')}</span>
        </div>
        <nav>
          <button className="settings-page-nav-item active" type="button" aria-current="page">
            <Archive size={15} aria-hidden="true" />
            <span>{t('appSettings.archivedChats')}</span>
            <span className="settings-page-nav-count">{sessions.length}</span>
          </button>
        </nav>
      </aside>

      <section className="settings-page-content">
        <div className="settings-page-inner">
          <header className="settings-page-heading">
            <h1>{t('appSettings.archivedChats')}</h1>
            <p>{t('appSettings.archivedDescription')}</p>
          </header>

          <label className="settings-page-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label={t('appSettings.searchArchived')}
              placeholder={t('appSettings.searchArchived')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query.length > 0 && (
              <button type="button" aria-label={t('sidebar.clearSearch')} onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </label>

          {groups.length === 0 ? (
            <div className="settings-page-empty">
              <Archive size={22} aria-hidden="true" />
              <h2>{normalizedQuery === '' ? t('appSettings.noArchived') : t('appSettings.noSearchResults')}</h2>
              {normalizedQuery === '' && <p>{t('appSettings.noArchivedDescription')}</p>}
            </div>
          ) : (
            <div className="settings-archive-groups">
              {groups.map((group) => (
                <section className="settings-archive-group" key={group.key}>
                  <header>
                    <Folder size={15} aria-hidden="true" />
                    <h2>{group.label}</h2>
                    <span>{t('appSettings.conversationCount', { count: group.sessions.length })}</span>
                  </header>
                  <div className="settings-archive-list">
                    {group.sessions.map((session) => {
                      const archivedAt = session.archivedAt ?? session.updatedAt
                      const date = formatArchiveDate(archivedAt, i18n.resolvedLanguage ?? i18n.language)
                      const busy = unarchivingId === session.id
                      return (
                        <article className="settings-archive-row" data-session-id={session.id} key={session.id}>
                          <div className="settings-archive-copy">
                            <h3>{session.title}</h3>
                            <time dateTime={archivedAt}>{t('appSettings.archivedOn', { date })}</time>
                          </div>
                          <button
                            className="settings-unarchive-button"
                            type="button"
                            disabled={unarchivingId !== undefined}
                            onClick={() => void unarchive(session.id)}
                          >
                            {busy
                              ? <LoaderCircle className="spin" size={13} aria-hidden="true" />
                              : <ArchiveRestore size={13} aria-hidden="true" />}
                            <span>{t('appSettings.unarchive')}</span>
                          </button>
                        </article>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function groupArchivedSessions(
  sessions: SessionSummary[],
  fallbackLabel: string,
): ArchivedGroup[] {
  const groups = new Map<string, ArchivedGroup>()
  const sorted = sessions.toSorted((a, b) => (
    (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt)
  ))

  for (const session of sorted) {
    const workspace = session.workingDirectory?.trim()
    const key = workspace === undefined || workspace === '' ? '__local__' : workspace
    const label = key === '__local__'
      ? fallbackLabel
      : key.split(/[\\/]/).filter(Boolean).at(-1) ?? key
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { key, label, sessions: [session] })
    else group.sessions.push(session)
  }

  return [...groups.values()].map((group) => ({
    ...group,
    sessions: group.sessions.toSorted((a, b) => (
      (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt)
    )),
  }))
}

function formatArchiveDate(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
