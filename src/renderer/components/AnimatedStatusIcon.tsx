import { useEffect, useState, useSyncExternalStore } from 'react'
import UseAnimations, { type Interaction } from 'react-useanimations'
import check from 'react-useanimations/lib/check'
import checkCircle from 'react-useanimations/lib/checkCircle'
import loading from 'react-useanimations/lib/loading'

export type AnimatedStatusIconName = 'check' | 'checkCircle' | 'loading'

export interface AnimatedStatusIconProps {
  name: AnimatedStatusIconName
  size?: number
  className?: string
  active?: boolean
  animateOnMount?: boolean
  interaction?: Interaction
  speed?: number
}

const ANIMATIONS = { check, checkCircle, loading } as const
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const media = window.matchMedia(REDUCED_MOTION_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion, () => false)
}

/**
 * Shared decorative animated icon wrapper.
 *
 * Colors follow currentColor and semantics stay on the surrounding button or
 * text. Controlled icons use click-toggle so external state can trigger them;
 * animateOnMount starts from the resting frame and advances after one paint.
 * react-useanimations destroys its player when the wrapper unmounts.
 */
export function AnimatedStatusIcon({
  name,
  size = 16,
  className,
  active,
  animateOnMount = false,
  interaction,
  speed = 1,
}: AnimatedStatusIconProps) {
  const reducedMotion = usePrefersReducedMotion()
  const [entered, setEntered] = useState(() => !animateOnMount || reducedMotion)
  const controlled = active !== undefined || animateOnMount
  const targetActive = active ?? true
  const resolvedInteraction = interaction ?? (controlled ? 'click-toggle' : undefined)
  const resolvedActive = controlled ? targetActive && (!animateOnMount || entered) : undefined

  useEffect(() => {
    if (!animateOnMount || reducedMotion) {
      setEntered(true)
      return
    }
    setEntered(false)
    const frame = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [animateOnMount, reducedMotion])

  const interactionProps = resolvedInteraction === undefined ? {} : { interaction: resolvedInteraction }
  const activeProps = resolvedActive === undefined ? {} : { active: resolvedActive }
  const playbackProps = name === 'loading'
    ? { autoplay: !reducedMotion, loop: !reducedMotion }
    : {}

  return (
    <UseAnimations
      {...interactionProps}
      {...activeProps}
      {...playbackProps}
      animation={ANIMATIONS[name]}
      aria-hidden="true"
      className={className}
      data-animated-status-icon={name}
      fillColor="currentColor"
      size={size}
      speed={speed}
      strokeColor="currentColor"
    />
  )
}
