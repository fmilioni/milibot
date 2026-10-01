import { cn } from '@/lib/cn'
/** "+3 −1" of a change; `strong` in bold. */
export function DiffStat({
  added,
  removed,
  strong = false,
}: {
  added: number
  removed: number
  strong?: boolean
}) {
  return (
    <span className={cn('shrink-0 font-mono text-xs tabular-nums', strong && 'font-semibold')}>
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  )
}
