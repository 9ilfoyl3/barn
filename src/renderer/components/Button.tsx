import { forwardRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react'
import {
  Button as BeuiButton,
  StatefulButton,
  type ButtonSize,
  type ButtonState,
  type ButtonVariant,
} from './beui/components/motion/button'
import './button.css'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  state?: ButtonState
  loadingText?: ReactNode
  successText?: ReactNode
  errorText?: ReactNode
  icon?: ReactNode
}

const PRIMARY = /\b(primary|primary-button|send-button|skills-primary-button)\b/
const OUTLINE = /\b(outline|outline-button|secondary-button|danger-button)\b/
const GHOST = /\b(ghost|quiet|icon-button|icon|tab|menu|row|command|suggestion|back|close|link|chip|toolbar|main|open|option|acknowledge)\b/
const ACTIVE = /\b(active|selected|current|pressed)\b/
const ICON = /\b(icon-button|icon|close|send-button|toolbar)\b/
const CONTENT = /\b(main|open|option|acknowledge|row|tab|menu|command|suggestion|chip|filter|item|back)\b/
const SMALL = /\b(compact|small|sm|tab|chip|menu|suggestion|toolbar|back)\b/

function inferVariant(className: string, active: boolean): ButtonVariant {
  if (PRIMARY.test(className)) return 'primary'
  if (OUTLINE.test(className)) return 'outline'
  if (GHOST.test(className) || active) return active ? 'secondary' : 'ghost'
  return 'secondary'
}

function inferSize(className: string): ButtonSize {
  if (ICON.test(className)) return 'icon'
  if (SMALL.test(className)) return 'sm'
  return 'md'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant,
  size,
  state,
  loadingText,
  successText,
  errorText,
  icon,
  className,
  type = 'button',
  style,
  children,
  ...props
}, ref) {
  const classText = className ?? ''
  const active = ACTIVE.test(classText)
    || props['aria-current'] !== undefined
    || props['aria-pressed'] === true
    || props['aria-selected'] === true
  const resolvedVariant = variant ?? inferVariant(classText, active)
  const resolvedSize = size ?? inferSize(classText)
  const tone = /\b(danger|destructive)\b/.test(classText) ? 'danger' : undefined
  const shared = {
    ...props,
    ref,
    type,
    variant: resolvedVariant,
    size: resolvedSize,
    className: classText === '' ? 'beui-button' : `beui-button ${classText}`,
    ...(style === undefined ? {} : { style }),
    'data-beui-variant': resolvedVariant,
    'data-beui-size': resolvedSize,
    ...(CONTENT.test(classText) ? { 'data-beui-layout': 'content' } : {}),
    ...(tone === undefined ? {} : { 'data-tone': tone }),
  }

  if (state !== undefined) {
    return (
      <StatefulButton
        {...(shared as unknown as ComponentProps<typeof StatefulButton>)}
        state={state}
        {...(loadingText === undefined ? {} : { loadingText })}
        {...(successText === undefined ? {} : { successText })}
        {...(errorText === undefined ? {} : { errorText })}
        {...(icon === undefined ? {} : { icon })}
      >
        {children}
      </StatefulButton>
    )
  }

  return <BeuiButton {...(shared as unknown as ComponentProps<typeof BeuiButton>)}>{children}</BeuiButton>
})
