import { Brain, FolderSearch, Settings2, Stethoscope, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import './settings-page.css'

export interface SettingsPageProps {
  onOpenModels: () => void
  onOpenSources: () => void
  onOpenDiagnostics: () => void
}

export function SettingsPage({ onOpenModels, onOpenSources, onOpenDiagnostics }: SettingsPageProps) {
  const { t } = useTranslation()
  const sections = [
    {
      key: 'models',
      icon: <Wrench size={16} aria-hidden="true" />,
      title: t('appSettings.modelsTitle'),
      description: t('appSettings.modelsDescription'),
      action: onOpenModels,
    },
    {
      key: 'sources',
      icon: <FolderSearch size={16} aria-hidden="true" />,
      title: t('appSettings.sourcesTitle'),
      description: t('appSettings.sourcesDescription'),
      action: onOpenSources,
    },
    {
      key: 'diagnostics',
      icon: <Stethoscope size={16} aria-hidden="true" />,
      title: t('appSettings.diagnosticsTitle'),
      description: t('appSettings.diagnosticsDescription'),
      action: onOpenDiagnostics,
    },
  ]

  return (
    <div className="settings-page">
      <aside className="settings-page-nav" aria-label={t('appSettings.navLabel')}>
        <div className="settings-page-nav-heading">
          <Settings2 size={16} aria-hidden="true" />
          <span>{t('appSettings.title')}</span>
        </div>
        <nav>
          <button className="settings-page-nav-item active" type="button" aria-current="page">
            <Brain size={15} aria-hidden="true" />
            <span>{t('appSettings.overview')}</span>
          </button>
        </nav>
      </aside>

      <section className="settings-page-content">
        <div className="settings-page-inner">
          <header className="settings-page-heading">
            <h1>{t('appSettings.title')}</h1>
            <p>{t('appSettings.description')}</p>
          </header>

          <div className="settings-section-grid">
            {sections.map((section) => (
              <article className="settings-section-card" key={section.key}>
                <span className="settings-section-icon">{section.icon}</span>
                <div>
                  <h2>{section.title}</h2>
                  <p>{section.description}</p>
                </div>
                <button type="button" onClick={section.action}>{t('appSettings.open')}</button>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
