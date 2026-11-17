import { useTranslation } from 'react-i18next'
import { AgentScreen as AgentScreenKit } from '@/components/beautiful-ui/agent-screen'

export interface AgentScreenProps {
  preview?: string | undefined
  onOpenBrowser: () => void
}

export function AgentScreen({ preview, onOpenBrowser }: AgentScreenProps) {
  const { t } = useTranslation()
  return (
    <aside className="agent-screen" data-testid="agent-screen" aria-label={t('browser.agentScreen')}>
      <AgentScreenKit
        className="agent-screen-live"
        title={t('browser.agentScreen')}
        mediaSrc={preview}
        mediaType="image"
        emptyLabel={t('browser.agentScreenReady')}
        loadingLabel={t('browser.loading')}
        openLabel={t('browser.openScreen')}
        showHeader={false}
        onExpandedChange={(expanded) => {
          if (expanded) onOpenBrowser()
        }}
      />
    </aside>
  )
}
