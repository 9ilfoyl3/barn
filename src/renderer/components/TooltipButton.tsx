import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Button } from './Button'

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
        <Button ref={ref} type="button" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  ),
)

TooltipButton.displayName = 'TooltipButton'
