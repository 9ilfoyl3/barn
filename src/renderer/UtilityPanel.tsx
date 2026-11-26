import { Globe2, Plus, Terminal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserHistoryEntry } from '../shared/models'
import { BrowserNewTab, type BrowserQuickAction } from './BrowserNewTab'
import { TerminalView } from './TerminalView'
import './utility-panel.css'
import { Button } from './components/Button'

export type UtilityTabType = 'empty' | 'terminal'
export interface UtilityTab {
  id: string
  type: UtilityTabType
  title: string
}

export interface UtilityPanelProps {
  tabs: UtilityTab[]
  activeTabId?: string | undefined
  workingDirectory?: string | undefined
  browserHistory: BrowserHistoryEntry[]
  onActivate: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onAddTab: () => void
  onNavigate: (url: string) => Promise<void>
  onQuickAction: (action: BrowserQuickAction) => void
  onClose: () => void
  onError: (message: string) => void
}

export function UtilityPanel({
  tabs,
  activeTabId,
  workingDirectory,
  browserHistory,
  onActivate,
  onCloseTab,
  onAddTab,
  onNavigate,
  onQuickAction,
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
              <Button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                onClick={() => onActivate(tab.id)}
              >
                {tab.type === 'terminal' ? <Terminal size={14} /> : <Globe2 size={14} />}
                <span>{tab.title}</span>
              </Button>
              <Button type="button" aria-label={t('browser.closeTab', { name: tab.title })} onClick={() => onCloseTab(tab.id)}>
                <X size={11} />
              </Button>
            </div>
          ))}
        </div>
        <Button className="utility-action" type="button" aria-label={t('browser.newTab')} onClick={onAddTab}>
          <Plus size={15} />
        </Button>
        <Button className="utility-action utility-close" type="button" aria-label={t('browser.closeSidePanel')} onClick={onClose}>
          <Globe2 size={16} />
        </Button>
      </header>
      <div className="utility-content">
        {tabs.map((tab) => (
          <div className="utility-tab-panel" hidden={tab.id !== activeTabId} key={tab.id}>
            {tab.type === 'terminal' ? (
              <TerminalView terminalId={tab.id} workingDirectory={workingDirectory} onError={onError} />
            ) : (
              <BrowserNewTab
                history={browserHistory}
                onNavigate={onNavigate}
                onQuickAction={onQuickAction}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
