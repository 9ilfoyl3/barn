import { describe, expect, it } from 'vitest'
import { computeFloatingMenuPosition, type FloatingMenuRect } from '../../src/renderer/floating-menu'

const menu = { width: 184, height: 140 }

function trigger(values: Partial<FloatingMenuRect> = {}): FloatingMenuRect {
  const left = values.left ?? 20
  const top = values.top ?? 100
  const width = values.width ?? 240
  const height = values.height ?? 40
  return {
    left,
    top,
    right: values.right ?? left + width,
    bottom: values.bottom ?? top + height,
    width,
    height,
  }
}

describe('computeFloatingMenuPosition', () => {
  it('opens to the right when enough horizontal space exists', () => {
    expect(computeFloatingMenuPosition({
      trigger: trigger(),
      menu,
      viewportWidth: 900,
      viewportHeight: 700,
    })).toEqual({ left: 268, top: 100, side: 'right' })
  })

  it('flips to the left when the right edge would overflow', () => {
    expect(computeFloatingMenuPosition({
      trigger: trigger({ left: 700, width: 180, right: 880 }),
      menu,
      viewportWidth: 900,
      viewportHeight: 700,
    })).toEqual({ left: 508, top: 100, side: 'left' })
  })

  it('moves the menu up to preserve the bottom viewport margin', () => {
    expect(computeFloatingMenuPosition({
      trigger: trigger({ top: 620, bottom: 660 }),
      menu,
      viewportWidth: 900,
      viewportHeight: 680,
    })).toEqual({ left: 268, top: 528, side: 'right' })
  })

  it('clamps both axes when neither side nor the bottom has enough space', () => {
    expect(computeFloatingMenuPosition({
      trigger: trigger({ left: 80, width: 120, right: 200, top: 250, bottom: 290 }),
      menu,
      viewportWidth: 260,
      viewportHeight: 300,
    })).toEqual({ left: 12, top: 148, side: 'left' })
  })
})
