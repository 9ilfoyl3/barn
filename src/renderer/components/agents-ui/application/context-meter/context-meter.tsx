"use client"

import { ChevronDown } from "lucide-react"

import { cx } from "@/components/boardui/utils/cx"

/**
 * Token-usage presentation adapted from Vercel AI Elements context (Apache-2.0).
 * https://github.com/vercel/ai-elements
 */
export type ContextSourceKind = "system" | "conversation" | "tools" | "retrieval" | "output" | "other"

export interface ContextSource {
  id: string
  label: string
  tokens: number
  kind?: ContextSourceKind
}

export interface AgentContextMeterProps {
  usedTokens: number
  totalTokens: number
  sources?: ContextSource[]
  label?: string
  showBreakdown?: boolean
  labels?: {
    tokensUsed?: string
    used?: string
    remaining?: string
    sourceBreakdown?: string
    otherContext?: string
    noSourceBreakdown?: string
  }
  className?: string
}

const number = new Intl.NumberFormat("en-US")
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export function AgentContextMeter({ usedTokens, totalTokens, sources = [], label = "Context window", showBreakdown = true, labels, className }: AgentContextMeterProps) {
  const safeTotal = Math.max(0, totalTokens)
  const safeUsed = Math.max(0, usedTokens)
  const percent = safeTotal > 0 ? Math.min(100, (safeUsed / safeTotal) * 100) : 0
  const remaining = Math.max(0, safeTotal - safeUsed)
  const supplied = sources.reduce((sum, source) => sum + Math.max(0, source.tokens), 0)
  const unallocated = Math.max(0, safeUsed - supplied)

  return <section className={cx("overflow-hidden rounded-xl border border-separator-border bg-background-primary-default", className)} aria-label={label}>
    <header className="p-4">
      <div className="flex items-start justify-between gap-4"><div><h2 className="text-sm font-medium text-text-primary">{label}</h2><p className="mt-1 text-xs text-text-secondary">{labels?.tokensUsed ?? `${compact.format(safeUsed)} of ${compact.format(safeTotal)} tokens used`}</p></div><span className="text-sm font-medium tabular-nums text-text-primary">{percent.toFixed(percent < 10 ? 1 : 0)}%</span></div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background-secondary-default" role="progressbar" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={safeTotal} aria-valuenow={Math.min(safeUsed, safeTotal)}><span className="block h-full bg-accent-600 transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${percent}%` }} /></div>
      <div className="mt-2 flex justify-between text-xs tabular-nums text-text-secondary"><span>{number.format(safeUsed)} {labels?.used ?? "used"}</span><span>{number.format(remaining)} {labels?.remaining ?? "remaining"}</span></div>
    </header>
    {showBreakdown && <details className="group border-t border-separator-border"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-xs font-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring">{labels?.sourceBreakdown ?? "Source breakdown"}<span className="text-text-secondary">{sources.length + (unallocated > 0 ? 1 : 0)}</span><ChevronDown className="ml-auto size-4 text-text-secondary transition-transform group-open:rotate-180" /></summary><div className="divide-y divide-separator-border border-t border-separator-border px-4">{sources.map((source) => <div key={source.id} className="grid grid-cols-[1fr_auto] gap-3 py-2.5 text-xs"><span className="min-w-0"><span className="block truncate text-text-primary">{source.label}</span>{source.kind && <span className="mt-0.5 block capitalize text-text-secondary">{source.kind}</span>}</span><span className="tabular-nums text-text-secondary">{number.format(Math.max(0, source.tokens))}</span></div>)}{unallocated > 0 && <div className="grid grid-cols-[1fr_auto] gap-3 py-2.5 text-xs"><span className="text-text-primary">{labels?.otherContext ?? "Other context"}</span><span className="tabular-nums text-text-secondary">{number.format(unallocated)}</span></div>}{sources.length === 0 && unallocated === 0 && <p className="py-3 text-xs text-text-secondary">{labels?.noSourceBreakdown ?? "No source breakdown supplied."}</p>}</div></details>}
  </section>
}
