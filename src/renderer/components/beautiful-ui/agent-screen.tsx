import { cx } from '@/components/boardui/utils/cx'
import {
  Check,
  Circle,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Radio,
  Square,
  type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import * as React from 'react'
import './agent-screen.css'

export type AgentScreenVariant = 'working' | 'loading'

export interface AgentScreenStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'complete'
}

export interface AgentScreenProps {
  title: string
  description?: string | undefined
  steps?: AgentScreenStep[] | undefined
  variant?: AgentScreenVariant | undefined
  mediaSrc?: string | undefined
  mediaType?: 'image' | 'video' | undefined
  expanded?: boolean | undefined
  recording?: boolean | undefined
  recordingElapsed?: string | undefined
  paused?: boolean | undefined
  className?: string | undefined
  openLabel?: string | undefined
  collapseLabel?: string | undefined
  loadingLabel?: string | undefined
  emptyLabel?: string | undefined
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  onStartRecording?: (() => void) | undefined
  onEndRecording?: (() => void) | undefined
  onPause?: (() => void) | undefined
  onResume?: (() => void) | undefined
}

interface ScreenButtonProps {
  children: React.ReactNode
  leadingIcon: LucideIcon
  variant?: 'secondary' | 'danger' | 'ghost'
  onClick?: (() => void) | undefined
}

function ScreenButton({ children, leadingIcon: Icon, variant = 'secondary', onClick }: ScreenButtonProps) {
  return (
    <button
      className={cx('agent-screen-kit-button', `is-${variant}`)}
      type="button"
      onClick={onClick}
    >
      <Icon size={14} />
      <span>{children}</span>
    </button>
  )
}

function ScreenMedia({
  src,
  type,
  loading,
  expanded,
  reduce,
  loadingLabel,
  emptyLabel,
}: {
  src: string | undefined
  type: 'image' | 'video' | undefined
  loading: boolean
  expanded: boolean
  reduce: boolean
  loadingLabel: string
  emptyLabel: string
}) {
  const video = type === 'video' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src ?? '')
  const key = loading ? 'loading' : src ? `${type ?? 'media'}-${src}` : 'empty'
  return (
    <div className={cx('agent-screen-kit-media', expanded && 'is-expanded')}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={key}
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          {...(reduce ? {} : { exit: { opacity: 0, y: -4 } })}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="agent-screen-kit-media-inner"
        >
          {loading ? (
            <div className="agent-screen-kit-empty">
              <LoaderCircle className={cx('agent-screen-kit-loader', !reduce && 'is-spinning')} size={20} />
              <span>{loadingLabel}</span>
            </div>
          ) : !src ? (
            <div className="agent-screen-kit-empty">
              <span className="agent-screen-kit-empty-mark" aria-hidden="true">◌</span>
              <span>{emptyLabel}</span>
            </div>
          ) : video ? (
            <video src={src} autoPlay muted loop playsInline className="agent-screen-kit-video" />
          ) : (
            <img src={src} alt="Agent screen" className="agent-screen-kit-image" />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/** MIT Agents Kit source adapted to Barn's local controls and semantic tokens. */
export function AgentScreen({
  title,
  description,
  steps = [],
  variant = 'working',
  mediaSrc,
  mediaType,
  expanded,
  recording = false,
  recordingElapsed,
  paused = false,
  className,
  openLabel = 'Open screen',
  collapseLabel = 'Collapse',
  loadingLabel = 'Connecting to agent screen',
  emptyLabel = 'No screen media supplied',
  onExpandedChange,
  onStartRecording,
  onEndRecording,
  onPause,
  onResume,
}: AgentScreenProps) {
  const reduce = useReducedMotion() ?? false
  const [localExpanded, setLocalExpanded] = React.useState(false)
  const open = expanded ?? localExpanded
  const showRecordingControls = onStartRecording !== undefined
    || onEndRecording !== undefined
    || onPause !== undefined
    || onResume !== undefined
  const changeOpen = (next: boolean): void => {
    if (expanded === undefined) setLocalExpanded(next)
    onExpandedChange?.(next)
  }

  return (
    <motion.section
      layout={!reduce}
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 390, damping: 38 }}
      className={cx(
        'agent-screen-kit',
        open ? 'is-expanded' : '',
        className,
      )}
    >
      <div className="agent-screen-kit-media-wrap">
        <ScreenMedia
          src={mediaSrc}
          type={mediaType}
          loading={variant === 'loading'}
          expanded={open}
          reduce={reduce}
          loadingLabel={loadingLabel}
          emptyLabel={emptyLabel}
        />
        {variant !== 'loading' && (
          <motion.div
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduce ? 0 : 0.16 }}
            className="agent-screen-kit-open-overlay"
          >
            <ScreenButton
              variant="secondary"
              leadingIcon={open ? Minimize2 : Maximize2}
              onClick={() => changeOpen(!open)}
            >
              {open ? collapseLabel : openLabel}
            </ScreenButton>
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {recording && variant !== 'loading' && (
            <motion.span
              initial={reduce ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              {...(reduce ? {} : { exit: { opacity: 0, y: -4 } })}
              transition={{ duration: reduce ? 0 : 0.15 }}
              className="agent-screen-kit-recording"
            >
              <Radio size={12} />
              Recording{recordingElapsed ? ` · ${recordingElapsed}` : ''}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <header className="agent-screen-kit-header">
        <div>
          <p className="agent-screen-kit-variant">{variant}</p>
          <h2>{title}</h2>
          {description !== undefined && <p className="agent-screen-kit-description">{description}</p>}
        </div>
        {variant !== 'loading' && showRecordingControls && (
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={recording ? (paused ? 'paused' : 'recording') : 'idle'}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              {...(reduce ? {} : { exit: { opacity: 0, y: -4 } })}
              transition={{ duration: reduce ? 0 : 0.15 }}
              className="agent-screen-kit-actions"
            >
              {recording ? (
                <ScreenButton variant="danger" leadingIcon={Square} onClick={onEndRecording}>
                  End recording
                </ScreenButton>
              ) : (
                <ScreenButton variant="secondary" leadingIcon={Radio} onClick={onStartRecording}>
                  Teach a task
                </ScreenButton>
              )}
              {recording && (paused ? (
                <ScreenButton variant="ghost" leadingIcon={Play} onClick={onResume}>Resume</ScreenButton>
              ) : (
                <ScreenButton variant="ghost" leadingIcon={Pause} onClick={onPause}>Pause</ScreenButton>
              ))}
            </motion.div>
          </AnimatePresence>
        )}
      </header>

      {steps.length > 0 && (
        <motion.div layout className="agent-screen-kit-steps">
          <AnimatePresence initial={false}>
            {steps.map((step) => {
              const Icon = step.status === 'complete'
                ? Check
                : step.status === 'running'
                  ? LoaderCircle
                  : Circle
              return (
                <motion.div
                  key={step.id}
                  layout="position"
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  {...(reduce ? {} : { exit: { opacity: 0, y: -4 } })}
                  transition={{ duration: reduce ? 0 : 0.14 }}
                  className="agent-screen-kit-step"
                >
                  <Icon
                    className={cx('agent-screen-kit-step-icon', step.status === 'running' && 'is-spinning')}
                    size={16}
                  />
                  <span>{step.label}</span>
                  <span className="agent-screen-kit-step-status">{step.status}</span>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </motion.section>
  )
}
