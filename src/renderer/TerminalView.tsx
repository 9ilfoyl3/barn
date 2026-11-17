import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

export interface TerminalViewProps {
  terminalId: string
  workingDirectory?: string | undefined
  onError: (message: string) => void
}

export function TerminalView({ terminalId, workingDirectory, onError }: TerminalViewProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [generation, setGeneration] = useState(0)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    setExited(false)
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: 'JetBrains Mono Variable, monospace',
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 8_000,
      theme: readTerminalTheme(container),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(container)
    fit.fit()
    terminal.focus()

    let ready = false
    const input = terminal.onData((data) => {
      if (ready) void window.barn.terminal.write(terminalId, data).catch((reason: unknown) => onError(errorMessage(reason)))
    })
    const unsubscribeData = window.barn.terminal.onData((event) => {
      if (event.terminalId === terminalId) terminal.write(event.data)
    })
    const unsubscribeExit = window.barn.terminal.onExit((event) => {
      if (event.terminalId !== terminalId) return
      ready = false
      setExited(true)
      terminal.write(`\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`)
    })
    const unsubscribeTheme = window.barn.theme.onChange(() => {
      terminal.options.theme = readTerminalTheme(container)
    })

    void window.barn.terminal.create({
      terminalId,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      cols: terminal.cols,
      rows: terminal.rows,
    }).then(() => {
      ready = true
      terminal.focus()
      void window.barn.terminal.resize(terminalId, terminal.cols, terminal.rows)
    }).catch((reason: unknown) => onError(errorMessage(reason)))

    let resizeFrame = 0
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return
        fit.fit()
        if (ready) void window.barn.terminal.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
      })
    })
    resizeObserver.observe(container)
    void document.fonts.ready.then(() => {
      fit.fit()
      if (ready) void window.barn.terminal.resize(terminalId, terminal.cols, terminal.rows)
    })

    return () => {
      ready = false
      cancelAnimationFrame(resizeFrame)
      resizeObserver.disconnect()
      unsubscribeData()
      unsubscribeExit()
      unsubscribeTheme()
      input.dispose()
      terminal.dispose()
      void window.barn.terminal.dispose(terminalId)
    }
  }, [generation, terminalId, workingDirectory])

  return (
    <div className="terminal-view">
      <div className="terminal-xterm" ref={containerRef} onClick={() => containerRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()} />
      {exited && (
        <div className="terminal-exit">
          <span>{t('terminal.exited')}</span>
          <button type="button" onClick={() => setGeneration((current) => current + 1)}>{t('terminal.restart')}</button>
        </div>
      )}
    </div>
  )
}

function readTerminalTheme(container: HTMLElement) {
  const style = getComputedStyle(container)
  const foreground = style.color
  const background = style.backgroundColor
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: colorMix(foreground, 24),
  }
}

function colorMix(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${alpha}%, transparent)`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
