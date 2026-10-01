import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { type Tone, TONE_FILL, TONE_SOFT } from '@/lib/tone'

/** Small rounded label (a source, an access level, a capability). */
export function Tag({
  icon,
  children,
  tone = 'neutral',
  size = 'md',
}: {
  icon?: ReactNode
  children: ReactNode
  tone?: Tone
  size?: 'md' | 'sm'
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md leading-none whitespace-nowrap',
        size === 'sm' ? 'h-3.5 px-1.5 text-2xs' : 'h-[17px] px-[7px] text-xs',
        TONE_SOFT[tone],
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** Pill with a status name ("Running", "Approved"). */
export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_SOFT[tone]}`}>
      {children}
    </span>
  )
}

/** Colored dot before a status text; `pulse` while something is in progress. */
export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        TONE_FILL[tone],
        pulse && 'animate-pulse motion-reduce:animate-none',
      )}
      aria-hidden
    />
  )
}
