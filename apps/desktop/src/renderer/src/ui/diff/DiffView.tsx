import { parseDiff } from '@milibot/shared'

import { cn } from '@/lib/cn'

/** Line diff of a prompt change: added lines in green, removed in red, skipped context as "⋯". */
export function DiffView({ diff, className = '' }: { diff: string; className?: string }) {
  const lines = parseDiff(diff)
  return (
    <div
      className={`selectable scroll-slim max-h-72 overflow-auto rounded-lg border border-border bg-surface font-mono text-xs leading-[17px] ${className}`}
    >
      {lines.map((line, i) =>
        line.op === 'gap' ? (
          <div key={i} className="px-2.5 text-fg-muted select-none">
            ⋯
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              'flex gap-2 px-2.5 whitespace-pre-wrap',
              line.op === '+'
                ? 'bg-success-soft text-fg'
                : line.op === '-'
                  ? 'bg-danger-tint text-fg-secondary line-through decoration-danger/40'
                  : 'text-fg-muted',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'w-2 shrink-0 select-none',
                line.op === '+' ? 'text-success' : line.op === '-' ? 'text-danger' : '',
              )}
            >
              {line.op === ' ' ? '' : line.op === '-' ? '−' : '+'}
            </span>
            <span className="min-w-0 break-words">{line.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  )
}
