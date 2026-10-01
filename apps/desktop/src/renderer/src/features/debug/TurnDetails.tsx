import type { LlmCallRow, ToolCallRow } from '@milibot/shared'
import { ChevronRight, Copy } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { compositionSegments } from '@/features/debug/lib/context-bar'
import {
  callTone,
  formatCost,
  formatLatency,
  shortModel,
  tokenBreakdown,
  type TurnRow,
} from '@/features/debug/lib/debug'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { compactTokens, formatClock } from '@/lib/format'
import { SectionTitle } from '@/ui/SectionTitle'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { useLlmCall, useTurnToolCalls } from './api'
import { Breakdown, CompositionBar, CompositionLegend, tokensHint, TONE_DOT } from './DebugParts'
import { JsonViewer } from './JsonViewer'
import { ToolCallItem } from './ToolCallItem'

function useCallPayload(callId: string): LlmCallRow | null {
  const workspaceId = useAppStore((s) => s.workspaceId)
  return useLlmCall(workspaceId, callId).data
}

/** Tools the turn ran, oldest first; null while loading. */
function useTurnTools(conversationId: string, turnId: string | null): ToolCallRow[] | null {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const { data } = useTurnToolCalls(workspaceId, conversationId, turnId)
  return turnId ? data : []
}

export function TurnDetails({ row, conversationId }: { row: TurnRow; conversationId: string }) {
  const { t, i18n } = useTranslation()
  const latest = row.calls[0] as LlmCallRow
  const composition = row.calls.find((c) => c.contextComposition)?.contextComposition ?? null
  const total = composition ? compositionSegments(composition).total : 0
  const tools = useTurnTools(conversationId, row.turn ? row.key : null)
  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 pt-2.5 pb-3">
      <Breakdown tokens={row.tokens} />
      {row.error && (
        <p className="selectable rounded-md bg-danger-tint px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-danger">
          {row.error}
        </p>
      )}
      {composition && total > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-fg">
            {t('panels.debug.composition', { tokens: compactTokens(total, i18n.language) })}
          </span>
          <CompositionBar composition={composition} />
          <CompositionLegend composition={composition} />
        </div>
      )}
      {tools === null ? (
        <Spinner className="text-fg-muted" />
      ) : (
        tools.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>{t('panels.debug.toolCalls', { count: tools.length })}</SectionTitle>
            {tools.map((tool) => (
              <ToolCallItem key={tool.id} tool={tool} />
            ))}
          </div>
        )
      )}
      {row.calls.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <SectionTitle>{t('panels.debug.callsCount', { count: row.calls.length })}</SectionTitle>
          {row.calls.map((call) => (
            <CallItem key={call.id} call={call} />
          ))}
        </div>
      ) : (
        <JsonToggle callId={latest.id} />
      )}
    </div>
  )
}

/** One LLM call of a multi-call turn; expands to its composition and JSON. */
function CallItem({ call }: { call: LlmCallRow }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [open, setOpen] = useState(false)
  const tone = callTone(call)
  const tokens = tokenBreakdown([call])
  const time = formatClock(call.createdAt, locale, { seconds: true })
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focus-ring flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-3/40"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        <span className="font-mono text-xs text-fg-muted">{time}</span>
        <span className="min-w-0 truncate text-fg-secondary">{shortModel(call.model)}</span>
        <span className="flex-1" />
        <Tooltip content={tokensHint(t, locale, tokens)}>
          <span className="text-fg-secondary">
            {t('panels.debug.tokens.total', { value: compactTokens(tokens.total, locale) })}
          </span>
        </Tooltip>
        <span className="text-fg-secondary">{formatCost(call.costUsd, locale)}</span>
        <span className="w-10 text-right text-fg-muted">{formatLatency(call.latencyMs, locale)}</span>
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
          <Breakdown tokens={tokens} />
          {call.error && (
            <p className="font-mono text-xs break-words whitespace-pre-wrap text-danger">{call.error}</p>
          )}
          {call.contextComposition && compositionSegments(call.contextComposition).total > 0 && (
            <>
              <CompositionBar composition={call.contextComposition} height={8} />
              <CompositionLegend composition={call.contextComposition} />
            </>
          )}
          <JsonToggle callId={call.id} />
        </div>
      )}
    </div>
  )
}

function JsonToggle({ callId }: { callId: string }) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  return shown ? (
    <PayloadViewer callId={callId} onHide={() => setShown(false)} />
  ) : (
    <button
      type="button"
      onClick={() => setShown(true)}
      className="focus-ring cursor-pointer self-start rounded text-sm text-accent hover:underline"
    >
      {t('panels.debug.showJson')}
    </button>
  )
}

function PayloadViewer({ callId, onHide }: { callId: string; onHide: () => void }) {
  const { t } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const full = useCallPayload(callId)
  const [side, setSide] = useState<'request' | 'response'>('request')
  const value = full ? (side === 'request' ? full.request : full.response) : null
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(value, null, 2)).then(() => showToast('copied'))
  }, [value, showToast])
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-bg p-2.5">
      <div className="flex items-center justify-between pb-1.5">
        <div className="flex gap-3 text-xs" role="tablist">
          {(['request', 'response'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={side === key}
              onClick={() => setSide(key)}
              className={cn(
                'focus-ring cursor-pointer rounded',
                side === key ? 'font-semibold text-accent' : 'text-fg-muted hover:text-fg',
              )}
            >
              {t(`panels.debug.${key}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={copy}
            disabled={value === null}
            className="focus-ring flex cursor-pointer items-center gap-1 rounded text-xs text-fg-muted hover:text-fg disabled:opacity-50"
          >
            <Copy size={12} />
            {t('panels.debug.copyJson')}
          </button>
          <button
            type="button"
            onClick={onHide}
            className="focus-ring cursor-pointer rounded text-xs text-fg-muted hover:text-fg"
          >
            {t('panels.debug.hideJson')}
          </button>
        </div>
      </div>
      <div className="scroll-slim max-h-[420px] overflow-auto">
        {!full ? (
          <Spinner className="text-fg-muted" />
        ) : value === null ? (
          <span className="text-xs text-fg-muted">{t('panels.debug.noPayload')}</span>
        ) : (
          <JsonViewer value={value} />
        )}
      </div>
    </div>
  )
}
