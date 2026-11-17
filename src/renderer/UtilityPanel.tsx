import { Globe2, MessageCircle, Plus, Terminal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SideChatView } from './SideChatView'
import { TerminalView } from './TerminalView'
import './utility-panel.css'

export type UtilityTabType = 'terminal' | 'side-chat'
export interface UtilityTab {
  id: string
  type: UtilityTabType
  title: string
}

export interface UtilityPanelProps {
  tabs: UtilityTab[]
  activeTabId?: string | undefined
  workingDirectory?: string | undefined
  onActivate: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onAddSideChat: () => void
  onClose: () => void
  onError: (message: string) => void
}

export function UtilityPanel({
  tabs,
  activeTabId,
  workingDirectory,
  onActivate,
  onCloseTab,
  onAddSideChat,
  onClose,
  onError,
}: UtilityPanelProps) {
  const { t } = useTranslation()
  return (
    <section className="utility-panel" data-testid="utility-panel" aria-label={t('browser.sideChat')}>
      <header className="utility-tabbar">
        <div className="utility-tab-list" role="tablist" aria-label={t('browser.sideChat')}>
          {tabs.map((tab) => (
            <div className={tab.id === activeTabId ? 'utility-tab active' : 'utility-tab'} key={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                onClick={() => onActivate(tab.id)}
              >
                {tab.type === 'terminal' ? <Terminal size={14} /> : <MessageCircle size={14} />}
                <span>{tab.title}</span>
              </button>
              <button type="button" aria-label={t('browser.closeTab', { name: tab.title })} onClick={() => onCloseTab(tab.id)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button className="utility-action" type="button" aria-label={t('browser.newSideChat')} onClick={onAddSideChat}>
          <Plus size={15} />
        </button>
        <button className="utility-action utility-close" type="button" aria-label={t('browser.closeSidePanel')} onClick={onClose}>
          <Globe2 size={16} />
        </button>
      </header>
      <div className="utility-content">
        {tabs.map((tab) => (
          <div className="utility-tab-panel" hidden={tab.id !== activeTabId} key={tab.id}>
            {tab.type === 'terminal' ? (
              <TerminalView terminalId={tab.id} workingDirectory={workingDirectory} onError={onError} />
            ) : (
              <SideChatView sessionId={tab.id} workingDirectory={workingDirectory} onError={onError} />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
