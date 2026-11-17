import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface TerminalLine {
  kind: 'command' | 'stdout' | 'stderr' | 'meta'
  text: string
}

export interface TerminalViewProps {
  terminalId: string
  workingDirectory?: string | undefined
  onError: (message: string) => void
}

export function TerminalView({ terminalId, workingDirectory, onError }: TerminalViewProps) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState(workingDirectory ?? '')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>()
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
  }, [lines, busy])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function submit(): Promise<void> {
    const command = input.trim()
    if (command.length === 0 || busy) return
    setInput('')
    setHistoryIndex(undefined)
    setHistory((current) => [...current.filter((entry) => entry !== command), command].slice(-100))
    if (command === 'clear') {
      setLines([])
      return
    }
    setBusy(true)
    setLines((current) => [...current, { kind: 'command', text: command }])
    try {
      const result = await window.barn.terminal.run({
        terminalId,
        command,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      })
      setCwd(result.cwd)
      setLines((current) => [
        ...current,
        ...(result.stdout.length > 0 ? [{ kind: 'stdout' as const, text: result.stdout.trimEnd() }] : []),
        ...(result.stderr.length > 0 ? [{ kind: 'stderr' as const, text: result.stderr.trimEnd() }] : []),
        ...(result.timedOut ? [{ kind: 'stderr' as const, text: t('terminal.timedOut') }] : []),
        ...(result.exitCode !== null && result.exitCode !== 0 ? [{ kind: 'meta' as const, text: t('terminal.exitCode', { code: result.exitCode }) }] : []),
      ])
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setLines((current) => [...current, { kind: 'stderr', text: message }])
      onError(message)
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  function recall(direction: 'up' | 'down'): void {
    if (history.length === 0) return
    const currentIndex = historyIndex ?? history.length
    const nextIndex = direction === 'up'
      ? Math.max(0, currentIndex - 1)
      : Math.min(history.length, currentIndex + 1)
    setHistoryIndex(nextIndex === history.length ? undefined : nextIndex)
    setInput(nextIndex === history.length ? '' : history[nextIndex] ?? '')
  }

  return (
    <div className="terminal-view">
      <div className="terminal-output" ref={outputRef}>
        {lines.length === 0 && <div className="terminal-meta">{t('terminal.ready', { cwd: cwd || 'workspace' })}</div>}
        {lines.map((line, index) => (
          <pre className={`terminal-line is-${line.kind}`} key={`${index}-${line.kind}`}>
            {line.kind === 'command' ? `→ ${line.text}` : line.text}
          </pre>
        ))}
        {busy && <div className="terminal-busy">{t('terminal.running')}</div>}
      </div>
      <form className="terminal-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <span className="terminal-prompt" aria-hidden="true">→</span>
        <span className="terminal-user">barn</span>
        <input
          ref={inputRef}
          aria-label={t('terminal.command')}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') { event.preventDefault(); recall('up') }
            if (event.key === 'ArrowDown') { event.preventDefault(); recall('down') }
          }}
          spellCheck={false}
          autoComplete="off"
        />
      </form>
    </div>
  )
}
