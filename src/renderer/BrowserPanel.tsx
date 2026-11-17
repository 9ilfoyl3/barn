import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Folder,
  Globe2,
  LoaderCircle,
  MessageCircle,
  Plus,
  RotateCw,
  Search,
  Terminal,
  X,
} from 'lucide-react'
import type { ApprovalRequest, BrowserState } from '../shared/models'

export type BrowserQuickAction = 'terminal' | 'files' | 'side-chat'

export interface BrowserPanelProps {
  state: BrowserState
  onBack: () => Promise<void>
  onClose: () => Promise<void>
  onForward: () => Promise<void>
  onNavigate: (url: string) => Promise<void>
  onReload: () => Promise<void>
  onNewTab: () => Promise<void>
  onActivateTab: (tabId: string) => Promise<void>
  onCloseTab: (tabId: string) => Promise<void>
  onRevealDownload: (downloadId: string) => Promise<void>
  onQuickAction: (action: BrowserQuickAction) => void
  approval?: ApprovalRequest | undefined
  onResolveApproval: (decision: 'approved' | 'denied') => Promise<void>
}

export function BrowserPanel({
  state,
  onBack,
  onClose,
  onForward,
  onNavigate,
  onReload,
  onNewTab,
  onActivateTab,
  onCloseTab,
  onRevealDownload,
  onQuickAction,
  approval,
  onResolveApproval,
}: BrowserPanelProps) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(state.url === 'about:blank' ? '' : state.url)
  const [submitting, setSubmitting] = useState(false)
  const isNewTab = state.url === 'about:blank'

  useEffect(() => {
    setAddress(state.url === 'about:blank' ? '' : state.url)
  }, [state.url])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    let frame = 0
    const reportBounds = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = viewport.getBoundingClientRect()
        void window.barn.browser.setBounds({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        })
      })
    }
    reportBounds()
    const observer = new ResizeObserver(reportBounds)
    observer.observe(viewport)
    window.addEventListener('resize', reportBounds)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [])

  async function submit(): Promise<void> {
    if (submitting || address.trim().length === 0) return
    setSubmitting(true)
    try {
      await onNavigate(browserTarget(address))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      className={[
        'browser-panel',
        approval === undefined ? '' : 'has-approval',
        isNewTab ? 'is-new-tab' : 'has-page',
      ].filter(Boolean).join(' ')}
      data-testid="browser-panel"
      aria-label="Browser"
    >
      <header className="browser-topbar">
        <div className="browser-tab-list" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((tab) => {
            const label = tab.title || (tab.url === 'about:blank' ? t('browser.newTab') : tab.url)
            return (
              <div className={tab.active ? 'browser-tab active' : 'browser-tab'} key={tab.id}>
                <button
                  className="browser-tab-select"
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  title={label}
                  onClick={() => void onActivateTab(tab.id)}
                >
                  {tab.loading ? <LoaderCircle className="browser-spinner" size={12} /> : <Globe2 size={12} />}
                  <span>{label}</span>
                </button>
                <button
                  className="browser-tab-close"
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => void onCloseTab(tab.id)}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <button className="browser-new-tab" type="button" aria-label="New tab" onClick={() => void onNewTab()}>
          <Plus size={14} />
        </button>
        {state.downloads[0] !== undefined && (
          <button
            className="browser-download-button"
            type="button"
            aria-label="Show latest download"
            title={`${state.downloads[0].filename} · ${state.downloads[0].state}`}
            onClick={() => void onRevealDownload(state.downloads[0]!.id)}
          >
            <Download size={14} />
            <span>{state.downloads.filter((download) => download.state === 'completed').length}</span>
          </button>
        )}
        <button className="browser-panel-close" type="button" aria-label="Close browser" onClick={() => void onClose()}>
          <X size={16} />
        </button>
      </header>

      {approval !== undefined && (
        <div className="browser-approval-bar" role="alertdialog" aria-label="Browser action approval">
          <div className="browser-approval-copy">
            <strong>Approve browser action?</strong>
            <span>{approval.summary}</span>
          </div>
          <div className="browser-approval-actions">
            <button type="button" className="is-deny" onClick={() => void onResolveApproval('denied')}>
              Deny
            </button>
            <button type="button" className="is-approve" aria-label="Approve browser action" onClick={() => void onResolveApproval('approved')}>
              Approve
            </button>
          </div>
        </div>
      )}

      {!isNewTab && (
        <div className="browser-toolbar">
          <button type="button" aria-label="Back" disabled={!state.canGoBack} onClick={() => void onBack()}>
            <ArrowLeft size={15} />
          </button>
          <button type="button" aria-label="Forward" disabled={!state.canGoForward} onClick={() => void onForward()}>
            <ArrowRight size={15} />
          </button>
          <form className="browser-address" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <span aria-hidden="true">{state.loading ? <LoaderCircle className="browser-spinner" size={14} /> : <Globe2 size={14} />}</span>
            <input
              aria-label="Browser address"
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t('browser.searchPlaceholder')}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </form>
          <button type="button" aria-label="Reload" onClick={() => void onReload()}>
            <RotateCw size={14} />
          </button>
        </div>
      )}

      <div className="browser-viewport" ref={viewportRef}>
        {isNewTab ? (
          <div className="browser-newtab">
            <form className="browser-newtab-search" onSubmit={(event) => { event.preventDefault(); void submit() }}>
              <Search size={18} aria-hidden="true" />
              <input
                aria-label="Browser address"
                type="text"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('browser.searchPlaceholder')}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </form>
            <div className="browser-newtab-section">
              <div className="browser-newtab-heading">
                <span>{t('browser.newTabSection')}</span>
                <button type="button" aria-label={t('browser.moreNewTabActions')}>···</button>
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
                <button type="button" onClick={() => onQuickAction('side-chat')}>
                  <span className="browser-newtab-card-icon"><MessageCircle size={18} /></span>
                  <span>{t('browser.sideChat')}</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="browser-viewport-placeholder">
            <Globe2 size={22} />
            <span>{state.error ?? (state.loading ? 'Loading page' : 'Enter a URL to start browsing')}</span>
          </div>
        )}
      </div>
    </section>
  )
}

function browserTarget(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed
  if (trimmed === 'localhost' || trimmed.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(trimmed)) {
    return trimmed
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
