import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Brain,
  Search,
  SlidersHorizontal,
  Stethoscope,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { changeAppLanguage, currentLanguagePreference, type LanguagePreference } from './i18n'
import { Input as BeuiInput } from './components/beui/components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/beui/components/motion/select'
import { MemorySettingsPanel } from './MemorySettingsPanel'
import { ModelSettings } from './ModelSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import type { ModelConfigSnapshot } from '../shared/models'
import './settings-page.css'
import { Button } from './components/Button'

export interface SettingsPageProps {
  snapshot: ModelConfigSnapshot | undefined
  onSnapshot(value: ModelConfigSnapshot): void
  initialSection?: SettingsSectionKey
}

export type SettingsSectionKey = 'general' | 'memory' | 'models' | 'diagnostics'
type SettingsGroupKey = 'preferences' | 'work' | 'system'

interface SettingsSectionDefinition {
  key: SettingsSectionKey
  group: SettingsGroupKey
  icon: ReactNode
  label: string
  title: string
  description: string
}

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LanguagePreference; labelKey: 'language.system' | 'language.english' | 'language.chinese' }> = [
  { value: 'system', labelKey: 'language.system' },
  { value: 'en', labelKey: 'language.english' },
  { value: 'zh-CN', labelKey: 'language.chinese' },
]

export function SettingsPage({ snapshot, onSnapshot, initialSection }: SettingsPageProps) {
  const { t } = useTranslation()
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(initialSection ?? 'general')
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState<LanguagePreference>(currentLanguagePreference())
  const [edgeState, setEdgeState] = useState({ top: false, bottom: false })
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const sections: SettingsSectionDefinition[] = [
    {
      key: 'general',
      group: 'preferences',
      icon: <SlidersHorizontal size={15} aria-hidden="true" />,
      label: t('appSettings.generalTitle'),
      title: t('appSettings.generalTitle'),
      description: t('appSettings.generalDescription'),
    },
    {
      key: 'memory',
      group: 'preferences',
      icon: <Brain size={15} aria-hidden="true" />,
      label: t('appSettings.memoryTitle'),
      title: t('appSettings.memoryTitle'),
      description: t('appSettings.memoryDescription'),
    },
    {
      key: 'models',
      group: 'work',
      icon: <Wrench size={15} aria-hidden="true" />,
      label: t('appSettings.modelsTitle'),
      title: t('appSettings.modelsTitle'),
      description: t('appSettings.modelsDescription'),
    },
    {
      key: 'diagnostics',
      group: 'system',
      icon: <Stethoscope size={15} aria-hidden="true" />,
      label: t('appSettings.diagnosticsTitle'),
      title: t('appSettings.diagnosticsTitle'),
      description: t('appSettings.diagnosticsDescription'),
    },
  ]

  const filteredSections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle.length === 0) return sections
    return sections.filter((section) =>
      [section.label, section.title, section.description]
        .some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [query, sections])

  const groups: Array<{ key: SettingsGroupKey; label: string }> = [
    { key: 'preferences', label: t('appSettings.preferencesGroup') },
    { key: 'work', label: t('appSettings.workGroup') },
    { key: 'system', label: t('appSettings.systemGroup') },
  ]
  const selected = sections.find((section) => section.key === activeSection) ?? sections[0]!

  useEffect(() => {
    if (initialSection !== undefined) setActiveSection(initialSection)
  }, [initialSection])

  useEffect(() => {
    const scroll = scrollRef.current
    if (scroll === null) return
    const update = (): void => {
      setEdgeState({
        top: scroll.scrollTop > 4,
        bottom: scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 4,
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [activeSection, query])

  async function updateLanguage(next: LanguagePreference): Promise<void> {
    setLanguage(next)
    await changeAppLanguage(next)
  }

  return (
    <div className="settings-page">
      <h1 className="settings-page-sr-title">{t('appSettings.title')}</h1>
      <aside className="settings-page-nav" aria-label={t('appSettings.navLabel')}>
        <BeuiInput
          className="settings-page-search"
          leftIcon={<Search size={14} aria-hidden="true" />}
          type="search"
          value={query}
          placeholder={t('appSettings.searchSettings')}
          aria-label={t('appSettings.searchSettings')}
          onChange={setQuery}
        />

        <nav className="settings-page-nav-groups" aria-label={t('appSettings.navLabel')}>
          {groups.map((group) => {
            const items = filteredSections.filter((section) => section.group === group.key)
            if (items.length === 0) return null
            return (
              <section className="settings-page-nav-group" key={group.key}>
                <h2>{group.label}</h2>
                <div>
                  {items.map((section) => (
                    <Button
                      key={section.key}
                      className={section.key === activeSection ? 'active' : ''}
                      type="button"
                      aria-current={section.key === activeSection ? 'page' : undefined}
                      onClick={() => setActiveSection(section.key)}
                    >
                      {section.icon}
                      <span>{section.label}</span>
                    </Button>
                  ))}
                </div>
              </section>
            )
          })}
          {filteredSections.length === 0 && (
            <p className="settings-page-nav-empty">{t('appSettings.noMatchingSettings')}</p>
          )}
        </nav>
      </aside>

      <section className="settings-page-content" aria-label={t('appSettings.contentLabel')} data-section={selected.key}>
        <div
          className="settings-page-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget
            setEdgeState({
              top: element.scrollTop > 4,
              bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 4,
            })
          }}
        >
          <div className="settings-page-inner">
            {selected.key !== 'models' && (
              <header className="settings-page-heading">
                <h1>{selected.title}</h1>
              </header>
            )}
            {selected.key === 'memory' ? <MemorySettingsPanel /> : selected.key === 'general' ? (
              <GeneralSettings language={language} onLanguageChange={(next) => void updateLanguage(next)} />
            ) : selected.key === 'models' ? (
              <ModelSettings snapshot={snapshot} onSnapshot={onSnapshot} embedded />
            ) : (
              <DiagnosticsSettings embedded />
            )}
          </div>
        </div>
        <div className={`settings-scroll-edge top${edgeState.top ? ' visible' : ''}`} aria-hidden="true" />
        <div className={`settings-scroll-edge bottom${edgeState.bottom ? ' visible' : ''}`} aria-hidden="true" />
      </section>
    </div>
  )
}

function GeneralSettings({
  language,
  onLanguageChange,
}: {
  language: LanguagePreference
  onLanguageChange(next: LanguagePreference): void
}) {
  const { t } = useTranslation()
  return (
    <div className="settings-groups">
      <SettingsGroup label={t('appSettings.privacyGroup')}>
        <SettingsRow
          title={t('appSettings.localDataTitle')}
          description={t('appSettings.localDataDescription')}
          control={<span className="settings-static-value">{t('appSettings.localOnlyValue')}</span>}
        />
      </SettingsGroup>

      <SettingsGroup label={t('appSettings.generalGroup')}>
        <SettingsRow
          title={t('appSettings.languageTitle')}
          description={t('appSettings.languageDescription')}
          control={(
            <Select
              value={language}
              className="settings-select-root"
              onValueChange={(value) => onLanguageChange(value as LanguagePreference)}
            >
              <SelectTrigger className="settings-select beui-select-trigger" ariaLabel={t('appSettings.languageTitle')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{t(option.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <SettingsRow
          title={t('appSettings.appearanceTitle')}
          description={t('appSettings.appearanceDescription')}
          control={<span className="settings-static-value">{t('appSettings.followSystem')}</span>}
        />
      </SettingsGroup>
    </div>
  )
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h2>{label}</h2>
      <div className="settings-card">{children}</div>
    </section>
  )
}

function SettingsRow({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: ReactNode
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}
