import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, Plus, RotateCw, X } from 'lucide-react'
import type { BrowserState } from '../shared/models'

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
}

export function BrowserPanel({ state, onBack, onClose, onForward, onNavigate, onReload, onNewTab, onActivateTab, onCloseTab }: BrowserPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(state.url === 'about:blank' ? '' : state.url)
  const [submitting, setSubmitting] = useState(false)

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
    if (submitting) return
    setSubmitting(true)
    try {
      await onNavigate(address)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="browser-panel" data-testid="browser-panel" aria-label="Browser">
      <header className="browser-panel-header">
        <div className="browser-panel-heading">
          <span className="browser-panel-icon" aria-hidden="true"><Globe2 size={15} /></span>
          <div className="browser-panel-title-copy">
            <span>Browser</span>
            <span className="browser-page-title" title={state.title || 'New tab'}>
              {state.title || 'New tab'}
            </span>
          </div>
        </div>
        <button className="browser-panel-close" type="button" aria-label="Close browser" onClick={() => void onClose()}>
          <X size={16} />
        </button>
      </header>

      <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
        <div className="browser-tab-list">
          {state.tabs.map((tab) => (
            <div className={tab.active ? 'browser-tab active' : 'browser-tab'} key={tab.id}>
              <button
                className="browser-tab-select"
                type="button"
                role="tab"
                aria-selected={tab.active}
                title={tab.title || tab.url || 'New tab'}
                onClick={() => void onActivateTab(tab.id)}
              >
                {tab.loading ? <LoaderCircle className="browser-spinner" size={12} /> : <Globe2 size={12} />}
                <span>{tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}</span>
              </button>
              <button
                className="browser-tab-close"
                type="button"
                aria-label={`Close ${tab.title || 'tab'}`}
                onClick={() => void onCloseTab(tab.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button className="browser-new-tab" type="button" aria-label="New tab" onClick={() => void onNewTab()}>
          <Plus size={14} />
        </button>
      </div>

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
            placeholder="Enter a URL"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <button type="button" aria-label="Reload" onClick={() => void onReload()}>
          <RotateCw size={14} />
        </button>
      </div>

      <div className="browser-viewport" ref={viewportRef}>
        <div className="browser-viewport-placeholder">
          <Globe2 size={22} />
          <span>{state.error ?? (state.loading ? 'Loading page' : 'Enter a URL to start browsing')}</span>
        </div>
      </div>
    </section>
  )
}
