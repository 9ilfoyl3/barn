import type { HTMLAttributes, ReactNode } from 'react'
import './reply-guide.css'

export type ReplyGuideMode = 'anchored' | 'straight' | 'none'

export interface ReplyGuideGroupProps extends HTMLAttributes<HTMLDivElement> {
  guide: ReplyGuideMode
  children: ReactNode
}

/** Shared assistant reply grouping and guide-line surface for both conversations and Task details. */
export function ReplyGuideGroup({
  guide,
  children,
  className,
  ...props
}: ReplyGuideGroupProps) {
  return (
    <div
      {...props}
      className={className === undefined ? 'assistant-reply-run' : `assistant-reply-run ${className}`}
      data-guide={guide}
    >
      {children}
    </div>
  )
}
