import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Streamdown, type Components } from 'streamdown'
import ToolChips, { type ToolStep } from '@/components/beautiful-ui/original/primitives/ToolChips'
import {
  groupConversationParts,
  type ChatMessage,
  type ConversationPart,
  type ToolCallView,
} from './conversation'

const STREAMDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <pre>{children}</pre>,
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
}

function ToolGroup({ tools }: { tools: ToolCallView[] }) {
  const { t } = useTranslation()
  const running = tools.find((tool) => tool.status === 'running')
  const [expanded, setExpanded] = useState(running !== undefined)
  const steps = tools.map((tool) => toolChipStep(tool))

  useEffect(() => {
    if (running !== undefined) setExpanded(true)
  }, [running])

  return (
    <ToolChips
      className="barn-tool-chips tool-group"
      diffLines={{}}
      diffs={[]}
      expanded={expanded}
      labels={{ header: toolGroupLabel(tools, t) }}
      onOpenChange={setExpanded}
      steps={steps}
      visibleStepCount={tools.length}
    />
  )
}

function toolGroupLabel(tools: ToolCallView[], t: ReturnType<typeof useTranslation>['t']): string {
  const running = tools.find((tool) => tool.status === 'running')
  if (running !== undefined) {
    const command = toolCommand(running)
    return command === undefined
      ? t('tools.running', { label: toolActionLabel(running.name, t) })
      : t('tools.runningCommand', { command: truncate(command, 72) })
  }
  if (tools.length === 1) return toolActionLabel(tools[0]?.name ?? '', t)
  if (tools.every((tool) => tool.name === 'shell')) return t('tools.ranCommands', { count: tools.length })
  if (tools.every((tool) => tool.name === 'read_file')) return t('tools.readFiles', { count: tools.length })
  const labels = [...new Set(tools.map((tool) => toolActionLabel(tool.name, t)))]
  return labels.join(' · ')
}

function toolChipStep(tool: ToolCallView): ToolStep {
  const action = tool.name === 'shell'
    ? 'run'
    : tool.name === 'write_file' || tool.name === 'edit_file'
      ? 'edit'
      : 'read'
  const argumentsText = toolArgumentsText(tool)
  const output = tool.output?.slice(0, 8_000) ?? ''
  const detail = [argumentsText, output]
    .filter((value) => value.length > 0)
    .map((text) => ({ text }))

  return {
    id: tool.id,
    icon: action === 'run' ? 'run' : action === 'edit' ? 'write' : 'read',
    label: toolDisplayName(tool.name),
    chip: toolThinkingTarget(tool),
    mono: true,
    detailMono: true,
    detail,
    status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'complete',
  }
}

function toolThinkingTarget(tool: ToolCallView): string {
  const parsed = toolArgumentsRecord(tool)
  for (const key of ['command', 'url', 'path', 'file_path', 'directory', 'folder', 'pattern', 'query', 'cwd']) {
    const value = parsed?.[key]
    if (typeof value === 'string' && value.trim().length > 0) return truncate(value.trim(), 72)
  }
  return toolDisplayName(tool.name)
}

function toolActionLabel(name: string, t: ReturnType<typeof useTranslation>['t']): string {
  switch (name) {
    case 'shell': return t('tools.shell')
    case 'read_file': return t('tools.readFile')
    case 'write_file': return t('tools.writeFile')
    case 'edit_file': return t('tools.editFile')
    case 'list_dir': return t('tools.listDir')
    case 'search_files': return t('tools.searchFiles')
    case 'find_files': return t('tools.findFiles')
    case 'view_image': return t('tools.viewImage')
    case 'memory_search': return t('tools.memorySearch')
    case 'memory_save': return t('tools.memorySave')
    case 'memory_forget': return t('tools.memoryForget')
    case 'browser_open': return t('tools.browserOpen')
    case 'browser_observe': return t('tools.browserObserve')
    case 'browser_act': return t('tools.browserAct')
    case 'browser_read': return t('tools.browserRead')
    case 'browser_tab': return t('tools.browserTab')
    case 'browser_upload': return t('tools.browserUpload')
    case 'browser_screenshot': return t('tools.browserScreenshot')
    default: return t('tools.ranTool', { name })
  }
}

function toolDisplayName(name: string): string {
  return name.split('_').map((part) => part.length === 0 ? part : `${part[0]?.toUpperCase()}${part.slice(1)}`).join(' ')
}

function toolCommand(tool: ToolCallView): string | undefined {
  const parsed = toolArgumentsRecord(tool)
  return typeof parsed?.command === 'string' && parsed.command.trim().length > 0
    ? parsed.command.trim()
    : undefined
}

function toolArgumentsText(tool: ToolCallView): string {
  const command = toolCommand(tool)
  if (command !== undefined) return `$ ${command}`
  const parsed = toolArgumentsRecord(tool)
  if (parsed === undefined) return tool.arguments
  return JSON.stringify(parsed, null, 2)
}

function toolArgumentsRecord(tool: ToolCallView): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(tool.arguments)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

type ThinkingConversationPart = Extract<ConversationPart, { type: 'thinking' }>

export function PendingThinking() {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  return (
    <div role="status" aria-live="polite">
      <ToolChips
        className="barn-tool-chips agent-thinking-pending"
        diffLines={{}}
        diffs={[]}
        expanded={expanded}
        labels={{ header: t('conversation.thinking') }}
        onOpenChange={setExpanded}
        steps={[{
          id: 'pending',
          icon: 'think',
          label: t('conversation.thinking'),
          chip: t('conversation.working'),
          mono: false,
          detailMono: false,
          detail: [],
          status: 'running',
        }]}
        visibleStepCount={1}
      />
    </div>
  )
}

function ThinkingBlock({ part }: { part: ThinkingConversationPart }) {
  const { t } = useTranslation()
  const streaming = part.streaming === true
  const [expanded, setExpanded] = useState(streaming)
  const [rowOpen, setRowOpen] = useState(streaming)

  useEffect(() => {
    setExpanded(streaming)
    setRowOpen(streaming)
  }, [streaming])

  const reasoning = part.text.trim()
  const steps: ToolStep[] = [{
    id: 'reasoning',
    icon: 'think',
    label: t('conversation.thoughtProcess'),
    chip: reasoning.length === 0 ? t('conversation.working') : truncate(reasoning.replaceAll(/\s+/g, ' '), 96),
    mono: false,
    detailMono: false,
    detail: reasoning.length === 0 ? [] : [{ text: part.text }],
    status: streaming ? 'running' : 'complete',
  }]

  return (
    <div className="conversation-part" data-part="thinking">
      <ToolChips
        className="barn-tool-chips agent-thinking-state"
        diffLines={{}}
        diffs={[]}
        expanded={expanded}
        expandedRowIds={rowOpen ? ['reasoning'] : []}
        labels={{ header: streaming ? t('conversation.thinking') : t('conversation.thoughtProcess') }}
        onOpenChange={setExpanded}
        onRowOpenChange={(_, open) => setRowOpen(open)}
        steps={steps}
        visibleStepCount={1}
      />
    </div>
  )
}

export function ConversationParts({
  parts,
  role,
  keyPrefix,
}: {
  parts: ConversationPart[]
  role: ChatMessage['role']
  keyPrefix: string
}) {
  const displayParts = groupConversationParts(parts)
  return (
    <div className="conversation-parts">
      {displayParts.map((part, index) => {
        if (part.type === 'thinking') {
          return <ThinkingBlock key={`${keyPrefix}:thinking:${index}`} part={part} />
        }
        if (part.type === 'tool-group') {
          return (
            <div
              className="conversation-part conversation-tool-group"
              data-part="tool-group"
              key={`${keyPrefix}:tools:${part.key}`}
            >
              <ToolGroup tools={part.tools} />
            </div>
          )
        }
        return (
          <div
            className={`conversation-part conversation-text${part.streaming === true ? ' streaming' : ''}`}
            data-part="text"
            key={`${keyPrefix}:text:${index}`}
          >
            {role === 'assistant' ? (
              <Streamdown
                className="message-copy assistant-markdown"
                components={STREAMDOWN_COMPONENTS}
                animated={part.streaming === true}
                isAnimating={part.streaming === true}
              >
                {part.text}
              </Streamdown>
            ) : (
              <div className="message-copy">{part.text}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
