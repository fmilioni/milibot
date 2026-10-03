import type { Bot, ConversationMemorySummary, InstructionFileInfo } from '@milibot/shared'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBotMemories } from '@/features/bots/api'
import { compositionSegments } from '@/features/debug/lib/context-bar'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { compactTokens, formatBytes, formatClock } from '@/lib/format'
import { SectionTitle } from '@/ui/SectionTitle'
import { Spinner } from '@/ui/Spinner'
import { Tag } from '@/ui/Tag'

import { useConversationSummaries } from './api'
import { CompositionBar, CompositionLegend, type DebugData } from './DebugParts'

export function ContextTab({
  data,
  bots,
  conversationId,
  members,
}: {
  data: DebugData
  bots: Record<string, Bot>
  conversationId: string
  members: Bot[]
}) {
  const { t, i18n } = useTranslation()
  const compositions = data.debug.latestComposition
  const [botId, setBotId] = useState<string | null>(null)
  const selected =
    compositions.find((c) => c.botId === botId) ??
    compositions.find((c) => c.botId !== null && members.some((m) => m.id === c.botId)) ??
    compositions[0] ??
    null
  const bot = selected?.botId ? bots[selected.botId] : (members[0] ?? null)
  const total = selected ? compositionSegments(selected.composition).total : 0
  const time = selected ? formatClock(selected.createdAt, i18n.language) : ''
  return (
    <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {compositions.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {compositions.map((c) => (
            <button
              key={c.llmCallId}
              type="button"
              aria-pressed={c === selected}
              onClick={() => setBotId(c.botId)}
              className={cn(
                'focus-ring rounded-full px-2.5 py-1 text-sm',
                c === selected
                  ? 'bg-accent-soft font-semibold text-accent'
                  : 'bg-surface-3 text-fg-secondary',
              )}
            >
              {(c.botId && bots[c.botId]?.name) ?? t('panels.debug.context.system')}
            </button>
          ))}
        </div>
      )}
      <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-2 p-3">
        {selected && total > 0 ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-base font-semibold text-fg">
                {t('panels.debug.composition', { tokens: compactTokens(total, i18n.language) })}
              </span>
              <span className="truncate font-mono text-xs text-fg-muted">
                {t('panels.debug.context.latest', { model: selected.model, time })}
              </span>
            </div>
            <CompositionBar composition={selected.composition} height={14} />
            <CompositionLegend composition={selected.composition} detailed />
          </>
        ) : (
          <span className="text-sm text-fg-muted">{t('panels.debug.noComposition')}</span>
        )}
      </section>
      {selected && <InstructionFiles files={selected.instructionFiles} />}
      {bot && <MemoryInUse bot={bot} conversationId={conversationId} />}
    </div>
  )
}

/** The repository's CLAUDE.md/AGENTS.md in the latest call: added by Milibot or read by the CLI itself. */
function InstructionFiles({ files }: { files: InstructionFileInfo[] }) {
  const { t, i18n } = useTranslation()
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle as="h3">{t('panels.debug.context.instructions', { count: files.length })}</SectionTitle>
      {files.length === 0 ? (
        <span className="text-sm text-fg-muted">{t('panels.debug.context.noInstructions')}</span>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm"
            >
              <span
                className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg"
                title={file.path}
              >
                {file.path}
              </span>
              {file.truncated && <Tag tone="warning">{t('panels.debug.context.truncated')}</Tag>}
              {file.source === 'engine' && <Tag>{t('panels.debug.context.readByCli')}</Tag>}
              <span className="shrink-0 font-mono text-2xs text-fg-muted">
                {formatBytes(file.bytes, i18n.language)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MemoryInUse({ bot, conversationId }: { bot: Bot; conversationId: string }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const memories = useBotMemories(workspaceId, bot.id)
  const notes = memories.data ?? (memories.error ? [] : null)
  const { data: summaries } = useConversationSummaries(workspaceId, conversationId, bot.id)
  const pinned = notes?.filter((n) => n.pinned) ?? []
  return (
    <>
      <section className="flex flex-col gap-2">
        <SectionTitle as="h3">
          {t('panels.debug.context.memory', { name: bot.name, count: pinned.length })}
        </SectionTitle>
        {notes === null ? (
          <Spinner className="text-fg-muted" />
        ) : pinned.length === 0 ? (
          <span className="text-sm text-fg-muted">{t('panels.debug.context.noMemory')}</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pinned.map((note) => (
              <li
                key={note.id}
                className="selectable flex gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-fg"
              >
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{note.content}</span>
                <span className="shrink-0 font-mono text-2xs text-fg-muted">{note.tokenCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <SectionTitle as="h3">
          {t('panels.debug.context.summaries', { count: summaries?.length ?? 0 })}
        </SectionTitle>
        {summaries === null ? (
          <Spinner className="text-fg-muted" />
        ) : summaries.length === 0 ? (
          <span className="text-sm text-fg-muted">{t('panels.debug.context.noSummaries')}</span>
        ) : (
          summaries.map((summary) => <SummaryItem key={summary.id} summary={summary} />)
        )}
      </section>
    </>
  )
}

function SummaryItem({ summary }: { summary: ConversationMemorySummary }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focus-ring flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm"
      >
        <ChevronRight
          size={11}
          className={cn(
            'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-fg">
          {open ? '' : summary.content.replace(/\s+/g, ' ').slice(0, 140)}
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-muted">
          {t('panels.debug.context.summaryRange', {
            from: summary.fromSeq,
            to: summary.toSeq,
            level: summary.level,
            tokens: compactTokens(summary.tokenCount, i18n.language),
          })}
        </span>
      </button>
      {open && (
        <p className="selectable border-t border-border px-2.5 py-2 text-sm break-words whitespace-pre-wrap text-fg-secondary">
          {summary.content}
        </p>
      )}
    </div>
  )
}
