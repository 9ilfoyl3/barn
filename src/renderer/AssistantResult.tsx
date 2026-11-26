import { ExternalLink, FileText, ListChecks, MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { VisibleResultCard } from '../shared/models'
import { Button } from './components/Button'

export function AssistantResult({
  card,
  onOpenLink,
  onOpenTask,
}: {
  card: VisibleResultCard
  onOpenLink: (url: string) => void
  onOpenTask?: () => void
}) {
  const { t } = useTranslation()
  const Icon = resultIcon(card.kind)
  return (
    <section className={`assistant-result assistant-result-${card.kind}`} aria-label={card.title}>
      <header className="assistant-result-heading">
        <span className="assistant-result-icon" aria-hidden="true"><Icon size={15} /></span>
        <span className="assistant-result-title">
          <strong>{card.title}</strong>
          {card.provider !== undefined && <small>{card.provider}</small>}
        </span>
        {card.status !== undefined && <span className="assistant-result-status">{card.status}</span>}
      </header>
      {card.image !== undefined && (
        <img
          className="assistant-result-image"
          src={card.image.dataUrl}
          alt={card.image.alt}
        />
      )}
      {card.description !== undefined && <p className="assistant-result-description">{card.description}</p>}
      {(card.meta !== undefined || card.href !== undefined || onOpenTask !== undefined) && (
        <footer className="assistant-result-footer">
          {card.meta !== undefined && <span>{card.meta}</span>}
          <span className="assistant-result-actions">
            {onOpenTask !== undefined && (
              <Button type="button" onClick={onOpenTask}>
                {t('tasks.openDetails')}
                <ListChecks size={12} aria-hidden="true" />
              </Button>
            )}
            {card.href !== undefined && (
              <Button type="button" onClick={() => onOpenLink(card.href!)}>
                {t('secretary.openResult')}
                <ExternalLink size={12} aria-hidden="true" />
              </Button>
            )}
          </span>
        </footer>
      )}
    </section>
  )
}

function resultIcon(kind: VisibleResultCard['kind']) {
  if (kind === 'file') return FileText
  if (kind === 'task') return ListChecks
  if (kind === 'map') return MapPin
  return ExternalLink
}
