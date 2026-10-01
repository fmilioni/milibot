import type { ToolCallRow } from '@milibot/shared'
import { ChevronRight } from 'lucide-react'
import { createElement, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isMonoKind, stepIcon, stepText } from '@/features/chat/lib/activity-steps'
import { formatLatency, toolResultText, toolResultTokens } from '@/features/debug/lib/debug'
import { Screenshot } from '@/features/vm/Screenshot'
import { markFromToolArgs } from '@/lib/click-mark'
import { cn } from '@/lib/cn'
import { compactTokens } from '@/lib/format'
import { SectionTitle } from '@/ui/SectionTitle'

import { JsonViewer } from './JsonViewer'

export function ToolCallItem({ tool }: { tool: ToolCallRow }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const kind = tool.kind ?? tool.toolName
  const label = tool.kind
    ? stepText({ kind: tool.kind, detail: tool.detail ?? '' }, t) || tool.toolName
    : tool.toolName
  const duration =
    tool.finishedAt !== null ? formatLatency(tool.finishedAt - tool.startedAt, i18n.language) : '…'
  const result = toolResultText(tool.result)
  const resultTokens = toolResultTokens(tool.result)
  const tone =
    tool.status === 'error' ? 'text-danger' : tool.status === 'cancelled' ? 'text-fg-muted' : 'text-success'
  const mark = markFromToolArgs(tool.toolName, tool.arguments)
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focus-ring flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-3/40"
      >
        {createElement(stepIcon(kind), {
          size: 13,
          className: `shrink-0 ${tool.status === 'error' ? 'text-danger' : 'text-accent'}`,
        })}
        <span className={cn('min-w-0 flex-1 truncate', isMonoKind(kind) && 'font-mono text-xs', 'text-fg')}>
          {label}
        </span>
        {resultTokens !== null && (
          <span className="shrink-0 text-xs text-fg-muted tabular-nums">
            {t('panels.debug.resultTokens', { tokens: compactTokens(resultTokens, i18n.language) })}
          </span>
        )}
        <span className={`shrink-0 text-xs ${tone}`}>{t(`panels.debug.toolStatus.${tool.status}`)}</span>
        <span className="w-10 shrink-0 text-right text-xs text-fg-muted">{duration}</span>
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      </button>
      {!open && tool.screenshotSha && mark && (
        <div className="px-2.5 pb-2">
          <Screenshot sha={tool.screenshotSha} mark={mark} className="w-40" />
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
          <SectionTitle>{t('panels.debug.arguments')}</SectionTitle>
          <JsonViewer value={tool.arguments} />
          <SectionTitle>{t('panels.debug.result')}</SectionTitle>
          {tool.error && (
            <p className="font-mono text-xs break-words whitespace-pre-wrap text-danger">{tool.error}</p>
          )}
          {result && <ToolResult text={result} />}
          {tool.screenshotSha && <Screenshot sha={tool.screenshotSha} mark={mark} className="w-64" />}
        </div>
      )}
    </div>
  )
}

const RESULT_PREVIEW = 1200

function ToolResult({ text }: { text: string }) {
  const { t } = useTranslation()
  const [full, setFull] = useState(false)
  const long = text.length > RESULT_PREVIEW
  return (
    <div className="flex flex-col gap-1">
      <pre className="selectable scroll-slim max-h-72 overflow-auto rounded bg-bg px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap text-fg-secondary">
        {long && !full ? `${text.slice(0, RESULT_PREVIEW)}…` : text}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="focus-ring cursor-pointer self-start rounded text-xs text-accent hover:underline"
        >
          {full ? t('panels.debug.showLess') : t('panels.debug.showMore', { count: text.length })}
        </button>
      )}
    </div>
  )
}
