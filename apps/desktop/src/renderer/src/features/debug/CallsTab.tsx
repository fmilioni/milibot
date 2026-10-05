import type { Bot, ConversationDebug, DebugTotals } from '@milibot/shared'
import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import {
  formatCost,
  formatLatency,
  formatPercent,
  shortModel,
  type TurnRow,
  turnRows,
} from '@/features/debug/lib/debug'
import { cn } from '@/lib/cn'
import { compactTokens, formatClock } from '@/lib/format'
import { Segmented } from '@/ui/Segmented'
import { Tooltip } from '@/ui/Tooltip'

import { type DebugData, Stat, tokensHint, TONE_DOT } from './DebugParts'
import { TurnDetails } from './TurnDetails'

type Scope = 'today' | 'all'

function SummaryStats({ debug, scope }: { debug: ConversationDebug; scope: Scope }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const totals: DebugTotals = scope === 'today' ? debug.today : debug.totals
  const suffix = scope === 'today' ? 'Today' : 'All'
  return (
    <div className="flex flex-wrap gap-2.5 px-4 pt-3.5">
      <Stat
        label={t(`panels.debug.stats.tokens${suffix}`)}
        value={compactTokens(totals.tokens, locale)}
        hint={tokensHint(t, locale, {
          input: totals.inputTokens,
          output: totals.outputTokens,
          cachedRead: totals.cachedReadTokens,
          cacheWrite: totals.cacheWriteTokens,
          reasoning: totals.reasoningTokens,
          total: totals.tokens,
        })}
      />
      <Stat label={t(`panels.debug.stats.cost${suffix}`)} value={formatCost(totals.costUsd, locale)} />
      <Stat label={t('panels.debug.stats.calls')} value={String(totals.calls)} />
      <Stat label={t('panels.debug.stats.cacheHit')} value={formatPercent(totals.cacheHitRate)} />
      <Stat
        label={t('panels.debug.stats.errors')}
        value={String(totals.errors)}
        {...(totals.errors > 0 ? { tone: 'danger' as const } : {})}
      />
    </div>
  )
}

export function CallsTab({
  data,
  bots,
  members,
  conversationId,
}: {
  data: DebugData
  bots: Record<string, Bot>
  members: Bot[]
  conversationId: string
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<Scope>('today')
  const [filter, setFilter] = useState<'all' | 'errors'>('all')
  const [botFilter, setBotFilter] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const rows = useMemo(() => turnRows(data.calls, data.debug.turns), [data])
  const visible = rows.filter(
    (row) =>
      (filter === 'all' || row.tone === 'error' || row.tone === 'retried') &&
      (!botFilter || row.botId === botFilter),
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SummaryStats debug={data.debug} scope={scope} />
      <div className="flex flex-wrap items-center gap-2 px-4 pt-2.5 pb-2">
        <Segmented
          size="xs"
          label={t('panels.debug.filterGroups.status')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('panels.debug.filter.all') },
            { value: 'errors', label: t('panels.debug.filter.errors') },
          ]}
        />
        {members.length > 1 && (
          <Segmented
            size="xs"
            label={t('panels.debug.filterGroups.bots')}
            value={botFilter ?? ''}
            onChange={(v) => setBotFilter(v || null)}
            options={[
              { value: '', label: t('panels.debug.filter.allBots') },
              ...members.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        )}
        <span className="flex-1" />
        <Segmented
          size="xs"
          label={t('panels.debug.filterGroups.scope')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'today', label: t('panels.debug.scope.today') },
            { value: 'all', label: t('panels.debug.scope.all') },
          ]}
        />
      </div>
      {/* Newest first; new rows land on top and the browser keeps the reading position when scrolled down. */}
      <div className="scroll-slim @container flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 pb-4">
        {visible.length === 0 ? (
          <span className="py-6 text-center text-sm text-fg-muted">{t('panels.debug.noErrors')}</span>
        ) : (
          visible.map((row) => (
            <TurnRowView
              key={row.key}
              row={row}
              bots={bots}
              conversationId={conversationId}
              open={open === row.key}
              onToggle={() => setOpen((current) => (current === row.key ? null : row.key))}
            />
          ))
        )}
      </div>
    </div>
  )
}

function TurnRowView({
  row,
  bots,
  conversationId,
  open,
  onToggle,
}: {
  row: TurnRow
  bots: Record<string, Bot>
  conversationId: string
  open: boolean
  onToggle: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const bot = row.botId ? bots[row.botId] : undefined
  const time = formatClock(row.startedAt, locale, { seconds: true })
  const snippet = row.turn?.trigger?.snippet ?? (row.badge ? t(`panels.debug.purposeHint.${row.badge}`) : '')
  const model = row.models[0] ? shortModel(row.models[0]) : ''
  const more = row.models.length > 1 ? ` +${row.models.length - 1}` : ''
  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-surface-2',
        open ? 'border-accent' : 'border-border hover:border-fg-muted/40',
        row.tone === 'error' && 'border-l-2 border-l-danger',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="focus-inset flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-surface-3/40"
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-sm">
          <Tooltip content={t(`panels.debug.tone.${row.tone}`)}>
            <span className={`size-2 shrink-0 rounded-full ${TONE_DOT[row.tone]}`} />
          </Tooltip>
          <span className="shrink-0 font-mono text-xs text-fg-muted">{time}</span>
          {bot ? (
            <span className="flex min-w-0 shrink items-center gap-1.5 @max-sm:shrink-0">
              <BotAvatar avatar={bot.avatar} state="idle" size={16} className="shrink-0" />
              <span className="truncate font-medium text-fg">{bot.name}</span>
            </span>
          ) : (
            <span className="truncate font-medium text-fg">{t('panels.debug.context.system')}</span>
          )}
          {row.badge && (
            <span className="shrink-0 rounded-[4px] bg-surface-3 px-1.5 text-2xs leading-4 text-fg-secondary">
              {t(`panels.debug.purpose.${row.badge}`)}
            </span>
          )}
          <span className="flex-1" />
          {model && (
            <Tooltip content={row.models.join(', ')}>
              <span className="min-w-0 truncate rounded-[4px] bg-accent-soft px-1.5 text-xs leading-[18px] text-accent @max-sm:hidden">
                {model}
                {more}
              </span>
            </Tooltip>
          )}
          <Tooltip content={tokensHint(t, locale, row.tokens)}>
            <span className="shrink-0 text-fg-secondary @max-sm:hidden">
              {t('panels.debug.tokens.total', { value: compactTokens(row.tokens.total, locale) })}
            </span>
          </Tooltip>
          <span className="shrink-0 text-fg-secondary">{formatCost(row.costUsd, locale)}</span>
          <span className="w-10 shrink-0 text-right text-fg-muted">
            {formatLatency(row.latencyMs, locale)}
          </span>
          <ChevronRight
            size={13}
            className={cn(
              'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </span>
        {snippet && (
          <Tooltip content={row.turn?.trigger?.snippet ?? null} maxWidth={420}>
            <span className="truncate pl-4 text-sm text-fg-secondary @max-sm:hidden">{snippet}</span>
          </Tooltip>
        )}
        {/* Narrow rows keep the bot's name whole: the model moves down here, before the snippet or tokens. */}
        {(model || snippet) && (
          <span className="hidden w-full min-w-0 items-center gap-2 pl-4 text-sm @max-sm:flex">
            {model && (
              <span className="max-w-[60%] shrink-0 truncate rounded-[4px] bg-accent-soft px-1.5 text-xs leading-[18px] text-accent">
                {model}
                {more}
              </span>
            )}
            <span className="min-w-0 truncate text-fg-secondary">
              {snippet || t('panels.debug.tokens.total', { value: compactTokens(row.tokens.total, locale) })}
            </span>
          </span>
        )}
        {row.error && (
          <span className="truncate pl-4 font-mono text-xs text-danger">
            {row.error.replace(/\s+/g, ' ')}
          </span>
        )}
      </button>
      {open && <TurnDetails row={row} conversationId={conversationId} />}
    </div>
  )
}
