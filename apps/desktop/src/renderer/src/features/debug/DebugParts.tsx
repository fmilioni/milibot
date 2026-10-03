import type { ContextComposition, ConversationDebug, LlmCallRow } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { type CompositionSegment, compositionSegments } from '@/features/debug/lib/context-bar'
import { type CallTone, formatPercent, type TokenBreakdown } from '@/features/debug/lib/debug'
import { cn } from '@/lib/cn'
import { compactTokens } from '@/lib/format'
import { Tooltip } from '@/ui/Tooltip'

export interface DebugData {
  debug: ConversationDebug
  calls: LlmCallRow[]
}

export const TONE_DOT: Record<CallTone, string> = {
  ok: 'bg-success',
  retried: 'bg-warning',
  limit: 'bg-warning',
  error: 'bg-danger',
  running: 'bg-accent animate-pulse motion-reduce:animate-none',
}

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone?: 'danger'
  hint?: string
}) {
  return (
    <Tooltip content={hint ?? null}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-border bg-surface-2 px-2.5 py-2">
        <span className="truncate text-xs text-fg-muted">{label}</span>
        <span
          className={cn('text-2xl leading-[21px] font-bold', tone === 'danger' ? 'text-danger' : 'text-fg')}
        >
          {value}
        </span>
      </div>
    </Tooltip>
  )
}

export function tokensHint(t: TFunction, locale: string, b: TokenBreakdown): string {
  return t('panels.debug.tokens.breakdown', {
    input: compactTokens(b.input, locale),
    output: compactTokens(b.output, locale),
    cached: compactTokens(b.cachedRead, locale),
    written: compactTokens(b.cacheWrite, locale),
  })
}

export function Breakdown({ tokens }: { tokens: TokenBreakdown }) {
  const { t, i18n } = useTranslation()
  type Key = 'input' | 'output' | 'cachedRead' | 'cacheWrite' | 'reasoning'
  const items: Array<[Key, number]> = [
    ['input', tokens.input],
    ['output', tokens.output],
    ['cachedRead', tokens.cachedRead],
    ['cacheWrite', tokens.cacheWrite],
  ]
  if (tokens.reasoning) items.push(['reasoning', tokens.reasoning])
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {items.map(([key, value]) => (
        <span key={key} className="text-fg-muted">
          {t(`panels.debug.tokens.${key}`)}{' '}
          <span className="font-medium text-fg">{compactTokens(value, i18n.language)}</span>
        </span>
      ))}
    </div>
  )
}

export function CompositionBar({
  composition,
  height = 10,
}: {
  composition: ContextComposition
  height?: number
}) {
  const { segments } = compositionSegments(composition)
  return (
    <div className="flex w-full overflow-hidden rounded-full bg-surface-3" style={{ height }}>
      {segments.map((s) => (
        <span key={s.key} className="h-full" style={{ width: `${s.width}%`, backgroundColor: s.color }} />
      ))}
    </div>
  )
}

function segmentLabel(segment: CompositionSegment, t: TFunction): string {
  if (segment.kind === 'mcp') return segment.name ?? 'MCP'
  if (segment.kind === 'images') return t('panels.debug.segments.images', { count: segment.count ?? 0 })
  return t(`panels.debug.segments.${segment.kind}`)
}

export function CompositionLegend({
  composition,
  detailed,
}: {
  composition: ContextComposition
  detailed?: boolean
}) {
  const { t, i18n } = useTranslation()
  const { total, segments } = compositionSegments(composition)
  if (detailed) {
    return (
      <table className="w-full text-sm">
        <tbody>
          {segments.map((s) => (
            <tr key={s.key} className="border-b border-border last:border-0">
              <td className="py-1.5">
                <span className="flex items-center gap-2 text-fg-secondary">
                  <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: s.color }} />
                  {segmentLabel(s, t)}
                </span>
              </td>
              <td className="py-1.5 text-right font-mono text-fg">
                {compactTokens(s.tokens, i18n.language)}
              </td>
              <td className="w-14 py-1.5 text-right font-mono text-fg-muted">
                {formatPercent(s.tokens / total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {segments.map((s) => (
        <span key={s.key} className="flex items-center gap-[5px] text-xs text-fg-secondary">
          <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: s.color }} />
          {segmentLabel(s, t)} {compactTokens(s.tokens, i18n.language)}
        </span>
      ))}
    </div>
  )
}
