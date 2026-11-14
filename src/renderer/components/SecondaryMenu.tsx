import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  computeFloatingMenuPosition,
  type FloatingMenuPosition,
  type FloatingMenuSide,
} from '../floating-menu'

interface SecondaryMenuProps {
  open: boolean
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
  className?: string
  id?: string
  role?: 'dialog' | 'menu'
  ariaLabel: string
  onSideChange?(side: FloatingMenuSide): void
}

export const SecondaryMenu = forwardRef<HTMLElement, SecondaryMenuProps>(function SecondaryMenu({
  open,
  anchor,
  children,
  className,
  id,
  role,
  ariaLabel,
  onSideChange,
}, forwardedRef) {
  const menuRef = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<FloatingMenuPosition>()

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined)
      onSideChange?.('right')
      return
    }

    const updatePosition = (): void => {
      const anchorElement = anchor.current
      const menuElement = menuRef.current
      if (anchorElement === null || menuElement === null) return
      const next = computeFloatingMenuPosition({
        trigger: anchorElement.getBoundingClientRect(),
        menu: menuElement.getBoundingClientRect(),
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight,
      })
      setPosition((current) => samePosition(current, next) ? current : next)
      onSideChange?.(next.side)
    }

    updatePosition()
    const observer = new ResizeObserver(updatePosition)
    if (anchor.current !== null) observer.observe(anchor.current)
    if (menuRef.current !== null) observer.observe(menuRef.current)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    // Parent popovers animate. Follow the anchor until its motion settles.
    let animationFrame = 0
    const startedAt = performance.now()
    const followAnchor = (): void => {
      updatePosition()
      if (performance.now() - startedAt < 360) {
        animationFrame = requestAnimationFrame(followAnchor)
      }
    }
    animationFrame = requestAnimationFrame(followAnchor)

    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchor, onSideChange, open])

  if (!open) return null

  return createPortal(
    <section
      ref={(element) => {
        menuRef.current = element
        assignRef(forwardedRef, element)
      }}
      id={id}
      className={`secondary-menu${className === undefined ? '' : ` ${className}`}`}
      data-ready={position === undefined ? 'false' : 'true'}
      data-side={position?.side}
      role={role}
      aria-label={ariaLabel}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position === undefined ? 'hidden' : 'visible',
      }}
    >
      {children}
    </section>,
    document.body,
  )
})

function samePosition(current: FloatingMenuPosition | undefined, next: FloatingMenuPosition): boolean {
  return current?.left === next.left
    && current.top === next.top
    && current.side === next.side
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref !== undefined) (ref as { current: T | null }).current = value
}
