import { Globe2, Maximize2 } from 'lucide-react'

export interface AgentScreenProps {
  preview?: string | undefined
  url: string
  title: string
  onOpenBrowser: () => void
}

export function AgentScreen({ preview, url, title, onOpenBrowser }: AgentScreenProps) {
  const displayUrl = visibleUrl(url)
  return (
    <aside className="agent-screen" data-testid="agent-screen" aria-label="Agent screen">
      <header className="agent-screen-header">
        <div className="agent-screen-identity">
          <span className="agent-screen-status" aria-hidden="true" />
          <span>Agent screen</span>
        </div>
        <button type="button" aria-label="Open browser" onClick={onOpenBrowser}>
          <Maximize2 size={14} />
        </button>
      </header>
      <button className="agent-screen-frame" type="button" aria-label="Open browser screen" onClick={onOpenBrowser}>
        {preview === undefined ? (
          <span className="agent-screen-empty">
            <Globe2 size={24} />
            <span>Browser is ready when you need it</span>
          </span>
        ) : (
          <img src={preview} alt="" />
        )}
      </button>
      <footer className="agent-screen-footer">
        <span>{title || 'Agent browser'}</span>
        <span>{displayUrl}</span>
      </footer>
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
