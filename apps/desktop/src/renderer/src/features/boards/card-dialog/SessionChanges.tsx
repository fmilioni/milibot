import { ChevronDown, GitCompare } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ChangesPane } from '@/features/sessions/ChangesPane'
import { useSessionStore } from '@/features/sessions/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { DiffStat } from '@/ui/diff/DiffStat'

/** The linked session's changes, folded to a line with its totals until opened. */
export function SessionChanges({
  sessionId,
  scrollParent,
}: {
  sessionId: string
  scrollParent: HTMLElement | null
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const totals = useSessionStore((s) => s.changes[sessionId]?.data?.totals)
  const loadChanges = useSessionStore((s) => s.loadChanges)
  const [open, setOpen] = useState(false)
  const panel = useId()

  // The folded line shows the totals, so they are read even while closed (the pane reloads them when open).
  useEffect(() => {
    void loadChanges(workspaceId, sessionId).catch(() => undefined)
  }, [loadChanges, workspaceId, sessionId])

  return (
    <section className="overflow-clip rounded-card border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="focus-inset flex min-h-10 w-full items-center gap-2.5 px-3 text-left hover:bg-surface-3/50"
      >
        <GitCompare size={14} className="shrink-0 text-fg-secondary" aria-hidden />
        <span className="text-base font-semibold text-fg">{t('boards.card.changes')}</span>
        {totals && (
          <>
            <span className="text-sm text-fg-secondary">
              {t('boards.card.changesFiles', { count: totals.files })}
            </span>
            <DiffStat added={totals.additions} removed={totals.deletions} />
          </>
        )}
        <span className="flex-1" />
        <span className="text-sm text-fg-secondary">
          {t(open ? 'boards.card.hideChanges' : 'boards.card.showChanges')}
        </span>
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-fg-secondary transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div id={panel} className="border-t border-border bg-surface-2">
          <ChangesPane sessionId={sessionId} scrollParent={scrollParent} />
        </div>
      )}
    </section>
  )
}
