import { useTranslation } from 'react-i18next'
import { AgentScreen as AgentScreenKit } from '@/components/beautiful-ui/agent-screen'

export interface AgentScreenProps {
  preview?: string | undefined
  url: string
  title: string
  onOpenBrowser: () => void
}

export function AgentScreen({ preview, url, title, onOpenBrowser }: AgentScreenProps) {
  const { t } = useTranslation()
  const displayUrl = visibleUrl(url)
  return (
    <aside className="agent-screen" data-testid="agent-screen" aria-label={t('browser.agentScreen')}>
      <AgentScreenKit
        className="agent-screen-live"
        title={title || t('browser.agentScreen')}
        description={displayUrl}
        mediaSrc={preview}
        mediaType="image"
        emptyLabel={t('browser.agentScreenReady')}
        loadingLabel={t('browser.loading')}
        openLabel={t('browser.openScreen')}
        onExpandedChange={(expanded) => {
          if (expanded) onOpenBrowser()
        }}
      />
    </aside>
  )
}

function visibleUrl(url: string): string {
  if (url === '' || url === 'about:blank') return 'Ready'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
