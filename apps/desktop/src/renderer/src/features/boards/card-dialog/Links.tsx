import type { Board, BoardCardDetail, BoardCardLink, BoardCardLinkKind } from '@milibot/shared'
import {
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Link2,
  ListChecks,
  PenTool,
  Plus,
  Terminal,
  X,
} from 'lucide-react'
import { createElement, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { prChip } from '@/features/boards/lib/boards'
import { useBoardStore } from '@/features/boards/store'
import { PlanDialog } from '@/features/plans/PlanDialog'
import { useSessionStore } from '@/features/sessions/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Tooltip } from '@/ui/Tooltip'

const LINK_ICONS: Record<BoardCardLinkKind, typeof ListChecks> = {
  plan: ListChecks,
  session: Terminal,
  design: PenTool,
  pr: GitPullRequest,
  commit: GitCommitHorizontal,
  url: Link2,
}

/** Grouped by kind, in this order. */
const KIND_ORDER: BoardCardLinkKind[] = ['plan', 'session', 'pr', 'commit', 'design', 'url']

const USER_LINK_KINDS = ['pr', 'commit', 'url'] as const

/** The "Links" block of the card's side column: header with "+ Link", the list and the form to add one. */
export function Links({
  board,
  detail,
  onChanged,
}: {
  board: Board
  detail: BoardCardDetail
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const openWorkSession = useAppStore((s) => s.openWorkSession)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const sessions = useSessionStore((s) => s.sessions)
  const addLink = useBoardStore((s) => s.addLink)
  const deleteLink = useBoardStore((s) => s.deleteLink)
  const [plan, setPlan] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<(typeof USER_LINK_KINDS)[number]>('pr')
  const [ref, setRef] = useState('')
  const links = [...detail.links].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))

  const open = (link: BoardCardLink) => {
    if (link.kind === 'plan') setPlan(link.ref)
    else if (link.kind === 'session') void toastOnError(openWorkSession(link.ref))
    else if (link.kind === 'design') void toastOnError(openCanvas(link.ref, null))
    else if (link.url) void window.milibot.openExternal(link.url)
  }
  const add = () => {
    if (!ref.trim()) return
    void toastOnError(addLink(workspaceId, board.id, detail.id, { kind, ref: ref.trim() })).then(() => {
      setRef('')
      setAdding(false)
      onChanged()
    })
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="card-links-title">
      <div className="flex min-h-11 items-center justify-between">
        <h3 id="card-links-title" className="text-sm font-semibold text-fg-secondary">
          {t('boards.card.links')}
        </h3>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="focus-ring hit flex h-8 items-center gap-1.5 rounded-md px-1.5 text-md font-semibold text-accent-strong hover:bg-accent-soft"
          >
            <Plus size={16} aria-hidden />
            {t('boards.card.addLink')}
          </button>
        )}
      </div>
      {links.length === 0 && !adding && (
        <p className="rounded-card border border-dashed border-fg-muted/60 px-4 py-3.5 text-base leading-[1.5] text-fg-secondary">
          {t('boards.card.noLinksHint')}
        </p>
      )}
      {links.length > 0 && (
        <ul className="flex flex-col overflow-hidden rounded-card border border-border bg-surface-2">
          {links.map((link) => {
            const clickable = link.kind !== 'commit' || Boolean(link.url)
            const chip = link.kind === 'pr' ? prChip(link) : null
            const session = link.kind === 'session' ? sessions[link.ref] : undefined
            const running = session?.status === 'preparing' || session?.status === 'running'
            const icon =
              chip?.state === 'done'
                ? GitMerge
                : chip?.state === 'failed'
                  ? GitPullRequestClosed
                  : LINK_ICONS[link.kind]
            return (
              <li key={link.id} className="group relative border-b border-border last:border-b-0">
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => open(link)}
                  className="focus-inset flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-3/60 disabled:cursor-default"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-secondary">
                    {createElement(icon, { size: 16, 'aria-hidden': true })}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-xs text-fg-secondary">
                      {t(`boards.links.${link.kind}`)}
                      {chip?.state && (
                        <span
                          className={cn(
                            'font-semibold',
                            chip.state === 'done'
                              ? 'text-success-strong'
                              : chip.state === 'failed'
                                ? 'text-danger-strong'
                                : 'text-accent-strong',
                          )}
                        >
                          {' · '}
                          {t(`boards.card.prState.${chip.state}`)}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-base font-medium text-fg">
                      {link.kind === 'commit'
                        ? `${link.ref.slice(0, 7)}${link.label !== link.ref.slice(0, 7) ? ` · ${link.label}` : ''}`
                        : link.label}
                    </span>
                  </span>
                  {running && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-success"
                      role="img"
                      aria-label={t('boards.card.running')}
                    />
                  )}
                  {link.kind === 'url' && (
                    <ExternalLink size={15} className="shrink-0 text-fg-secondary" aria-hidden />
                  )}
                </button>
                <Tooltip content={t('boards.card.removeLink')}>
                  <button
                    type="button"
                    aria-label={t('boards.card.removeLink')}
                    onClick={() =>
                      void toastOnError(deleteLink(workspaceId, board.id, detail.id, link.id)).then(onChanged)
                    }
                    className="focus-ring absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-surface-2 text-fg-secondary opacity-0 group-hover:opacity-100 hover:text-danger-strong focus-visible:opacity-100"
                  >
                    <X size={13} />
                  </button>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      )}
      {adding && (
        <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-4">
          <span id="link-kind-label" className="text-sm font-semibold text-fg-secondary">
            {t('boards.card.linkKind')}
          </span>
          <div
            role="group"
            aria-labelledby="link-kind-label"
            className="flex gap-0.5 rounded-lg bg-surface-3 p-[3px]"
          >
            {USER_LINK_KINDS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={cn(
                  'focus-ring hit h-9 min-w-0 flex-1 rounded-md px-1.5 text-sm whitespace-nowrap',
                  kind === value
                    ? 'bg-surface-2 font-semibold text-fg shadow-sm'
                    : 'text-fg-secondary hover:text-fg',
                )}
              >
                {t(`boards.links.${value}`)}
              </button>
            ))}
          </div>
          <input
            autoFocus
            value={ref}
            placeholder={t(`boards.card.linkPlaceholder.${kind}`)}
            aria-label={t(`boards.card.linkPlaceholder.${kind}`)}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
              if (e.key === 'Escape') {
                e.preventDefault()
                setAdding(false)
              }
            }}
            className="selectable h-11 rounded-lg border border-border bg-surface-2 px-3 text-base text-fg outline-none placeholder:text-fg-secondary focus:border-accent focus:ring-4 focus:ring-accent-soft"
          />
          <div className="flex justify-end gap-2">
            <Button size="lg" variant="ghost" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" variant="primary" disabled={!ref.trim()} onClick={add}>
              {t('boards.card.addLink')}
            </Button>
          </div>
        </div>
      )}
      {plan && <PlanDialog planId={plan} onClose={() => setPlan(null)} />}
    </section>
  )
}
