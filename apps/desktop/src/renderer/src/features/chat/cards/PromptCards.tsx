import type { Bot, PromptUpdatedPayload } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { ChevronDown, ChevronRight, NotebookPen, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DiffStat } from '@/ui/diff/DiffStat'
import { DiffView } from '@/ui/diff/DiffView'

/** Title of a prompt change: "Ana updated her own prompt" / "Boss updated Ana's prompt". */
function promptUpdatedTitle(
  payload: Pick<PromptUpdatedPayload, 'botId' | 'authorBotId'>,
  bots: Record<string, Bot>,
  t: TFunction,
): string {
  const target = bots[payload.botId]?.name ?? '…'
  if (!payload.authorBotId || payload.authorBotId === payload.botId)
    return t('chat.prompt.updatedOwn', { name: target })
  return t('chat.prompt.updatedOther', { name: bots[payload.authorBotId]?.name ?? '…', botName: target })
}

/** "Ana updated her own prompt" with the +/− summary, the reason, the diff and "Undo". */
export function PromptUpdatedCard({
  payload,
  bots,
  onUndo,
}: {
  payload: PromptUpdatedPayload
  bots: Record<string, Bot>
  onUndo?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const undo = () => {
    if (!onUndo || busy) return
    setBusy(true)
    void onUndo().finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-accent-soft px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <NotebookPen size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-accent">
          {promptUpdatedTitle(payload, bots, t)}
        </span>
        <DiffStat added={payload.added} removed={payload.removed} strong />
        {payload.undone ? (
          <span className="shrink-0 text-sm font-medium text-fg-muted">{t('chat.prompt.undone')}</span>
        ) : (
          onUndo && (
            <button
              type="button"
              disabled={busy}
              onClick={undo}
              className="focus-ring flex shrink-0 items-center gap-1 rounded text-sm font-semibold text-accent hover:underline disabled:opacity-50"
            >
              <Undo2 size={12} />
              {t('chat.prompt.undo')}
            </button>
          )
        )}
      </div>
      {payload.reason && <p className="pl-6 text-sm text-fg-secondary">{payload.reason}</p>}
      {payload.diff && (
        <div className="flex flex-col gap-1.5 pl-6">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="focus-ring flex w-fit items-center gap-1 rounded text-sm text-fg-secondary hover:text-fg"
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {open ? t('chat.prompt.hideChanges') : t('chat.prompt.showChanges')}
          </button>
          {open && <DiffView diff={payload.diff} />}
        </div>
      )}
    </div>
  )
}

/** Expandable diff of a prompt change waiting for approval (confirmation card). */
export function ProposedPromptDiff({
  diff,
  added,
  removed,
}: {
  diff: string
  added: number
  removed: number
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="focus-ring flex w-fit items-center gap-1.5 rounded text-sm text-fg-secondary hover:text-fg"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? t('chat.prompt.hideChanges') : t('chat.prompt.showChanges')}
        <DiffStat added={added} removed={removed} strong />
      </button>
      {open && <DiffView diff={diff} />}
    </div>
  )
}
