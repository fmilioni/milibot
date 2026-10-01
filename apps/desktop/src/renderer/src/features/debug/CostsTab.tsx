import type { ConversationDebug } from '@milibot/shared'
import { useTranslation } from 'react-i18next'

import { formatCost, formatPercent } from '@/features/debug/lib/debug'
import { compactTokens } from '@/lib/format'
import { Tooltip } from '@/ui/Tooltip'

import { tokensHint } from './DebugParts'

export function CostsTab({ debug }: { debug: ConversationDebug }) {
  const { t, i18n } = useTranslation()
  const rows = debug.byModel
  const max = Math.max(...rows.map((r) => r.costUsd), 0)
  return (
    <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-2xs font-semibold text-fg-muted">
            <th className="pb-2 font-semibold">{t('panels.debug.costs.model')}</th>
            <th className="pb-2 text-right font-semibold">{t('panels.debug.costs.calls')}</th>
            <th className="pb-2 text-right font-semibold">{t('panels.debug.costs.tokens')}</th>
            <th className="pb-2 text-right font-semibold">{t('panels.debug.costs.cacheHit')}</th>
            <th className="pb-2 text-right font-semibold">{t('panels.debug.costs.cost')}</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {rows.map((row) => (
            <tr key={row.model} className="border-t border-border">
              <td className="py-2 pr-2">
                <div className="flex flex-col gap-1">
                  <span className="truncate text-fg">{row.model}</span>
                  <span
                    className="h-1 rounded-full bg-accent"
                    style={{ width: `${max > 0 ? (row.costUsd / max) * 100 : 0}%` }}
                  />
                </div>
              </td>
              <td className="py-2 text-right text-fg-secondary">{row.calls}</td>
              <td className="py-2 text-right text-fg-secondary">
                <Tooltip
                  content={tokensHint(t, i18n.language, {
                    input: row.inputTokens,
                    output: row.outputTokens,
                    cachedRead: row.cachedReadTokens,
                    cacheWrite: row.cacheWriteTokens,
                    reasoning: row.reasoningTokens,
                    total: row.tokens,
                  })}
                >
                  <span>{compactTokens(row.tokens, i18n.language)}</span>
                </Tooltip>
              </td>
              <td className="py-2 text-right text-fg-secondary">{formatPercent(row.cacheHitRate)}</td>
              <td className="py-2 text-right text-fg">{formatCost(row.costUsd, i18n.language)}</td>
            </tr>
          ))}
          <tr className="border-t border-border font-semibold">
            <td className="py-2 font-sans text-fg">{t('panels.debug.costs.total')}</td>
            <td className="py-2 text-right text-fg">{debug.totals.calls}</td>
            <td className="py-2 text-right text-fg">{compactTokens(debug.totals.tokens, i18n.language)}</td>
            <td className="py-2 text-right text-fg">{formatPercent(debug.totals.cacheHitRate)}</td>
            <td className="py-2 text-right text-fg">{formatCost(debug.totals.costUsd, i18n.language)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-fg-muted">{t('panels.debug.costs.hint')}</p>
    </div>
  )
}
