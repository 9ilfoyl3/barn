export type FloatingMenuSide = 'left' | 'right'

export interface FloatingMenuRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface FloatingMenuPosition {
  left: number
  top: number
  side: FloatingMenuSide
}

interface FloatingMenuGeometry {
  trigger: FloatingMenuRect
  menu: Pick<FloatingMenuRect, 'width' | 'height'>
  viewportWidth: number
  viewportHeight: number
  gap?: number
  margin?: number
}

const DEFAULT_GAP = 8
const DEFAULT_MARGIN = 12

export function computeFloatingMenuPosition({
  trigger,
  menu,
  viewportWidth,
  viewportHeight,
  gap = DEFAULT_GAP,
  margin = DEFAULT_MARGIN,
}: FloatingMenuGeometry): FloatingMenuPosition {
  const menuWidth = Math.min(menu.width, Math.max(0, viewportWidth - margin * 2))
  const menuHeight = Math.min(menu.height, Math.max(0, viewportHeight - margin * 2))
  const rightCandidate = trigger.right + gap
  const leftCandidate = trigger.left - menuWidth - gap
  const rightFits = rightCandidate + menuWidth <= viewportWidth - margin
  const leftFits = leftCandidate >= margin
  const side: FloatingMenuSide = rightFits
    ? 'right'
    : leftFits
      ? 'left'
      : viewportWidth - trigger.right >= trigger.left
        ? 'right'
        : 'left'
  const preferredLeft = side === 'right' ? rightCandidate : leftCandidate
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin)
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin)

  return {
    left: clamp(preferredLeft, margin, maxLeft),
    top: clamp(trigger.top, margin, maxTop),
    side,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
