import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type TooltipContentProps = ComponentPropsWithoutRef<typeof TooltipContent>

interface TooltipButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> {
  label: string
  tooltipSide?: TooltipContentProps['side']
  children: ReactNode
}

export const TooltipButton = forwardRef<HTMLButtonElement, TooltipButtonProps>(
  ({ label, tooltipSide = 'bottom', children, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button ref={ref} type="button" aria-label={label} {...props}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  ),
)

TooltipButton.displayName = 'TooltipButton'
