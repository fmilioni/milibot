import type { Board, BoardCardDetail, BoardCardLink, BoardCardLinkKind } from '@milibot/shared'
import {
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Link2,
  ListChecks,
  PenTool,
  Plus,
  Terminal,
  X,
} from 'lucide-react'
import { createElement, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBoardStore } from '@/features/boards/store'
import { PlanDialog } from '@/features/plans/PlanDialog'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Select } from '@/ui/Select'
import { TextInput } from '@/ui/TextInput'

const LINK_ICONS: Record<BoardCardLinkKind, typeof ListChecks> = {
  plan: ListChecks,
  session: Terminal,
  design: PenTool,
  pr: GitPullRequest,
  commit: GitCommitHorizontal,
  url: Link2,
}

const USER_LINK_KINDS = ['pr', 'commit', 'url'] as const

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
  const addLink = useBoardStore((s) => s.addLink)
  const deleteLink = useBoardStore((s) => s.deleteLink)
  const [plan, setPlan] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<(typeof USER_LINK_KINDS)[number]>('pr')
  const [ref, setRef] = useState('')

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
    <div className="flex flex-col gap-2">
      {detail.links.length === 0 && <p className="text-sm text-fg-muted">{t('boards.card.noLinks')}</p>}
      {detail.links.map((link) => {
        const clickable = link.kind !== 'commit' || Boolean(link.url)
        return (
          <div key={link.id} className="group relative">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => open(link)}
              className="flex w-full gap-2.5 rounded-[9px] border border-border outline-none focus-visible:border-accent bg-surface-2 px-2.5 py-2 text-left hover:border-fg-muted/40 disabled:cursor-default"
            >
              {createElement(link.kind === 'pr' && link.state === 'done' ? GitMerge : LINK_ICONS[link.kind], {
                size: 14,
                className: 'mt-0.5 shrink-0 text-fg-secondary',
                'aria-hidden': true,
              })}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-2xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
                  {t(`boards.links.${link.kind}`)}
                </span>
                <span className="text-sm leading-[1.3] font-semibold break-words text-fg">
                  {link.kind === 'commit'
                    ? `${link.ref.slice(0, 7)}${link.label !== link.ref.slice(0, 7) ? ` · ${link.label}` : ''}`
                    : link.label}
                </span>
                {link.kind === 'pr' && link.state && (
                  <span
                    className={cn(
                      'text-xs',
                      link.state === 'done'
                        ? 'text-success'
                        : link.state === 'failed'
                          ? 'text-danger'
                          : 'text-accent',
                    )}
                  >
                    {t(`boards.card.prState.${link.state}` as never)}
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              aria-label={t('boards.card.removeLink')}
              onClick={() =>
                void toastOnError(deleteLink(workspaceId, board.id, detail.id, link.id)).then(onChanged)
              }
              className="focus-ring absolute top-1.5 right-1.5 rounded text-fg-muted opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      {adding ? (
        <div className="flex flex-col gap-1.5">
          <Select
            value={kind}
            size="sm"
            label={t('boards.card.linkKind')}
            onChange={setKind}
            options={USER_LINK_KINDS.map((value) => ({ value, label: t(`boards.links.${value}`) }))}
          />
          <TextInput
            autoFocus
            value={ref}
            placeholder={t(`boards.card.linkPlaceholder.${kind}`)}
            aria-label={t(`boards.card.linkPlaceholder.${kind}`)}
            className="!h-[30px] text-sm"
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
              if (e.key === 'Escape') {
                e.preventDefault()
                setAdding(false)
              }
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" disabled={!ref.trim()} onClick={add}>
              {t('boards.card.addLink')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="focus-ring flex items-center gap-1.5 self-start rounded px-0.5 text-sm text-fg-muted hover:text-fg-secondary"
        >
          <Plus size={13} aria-hidden />
          {t('boards.card.addLink')}
        </button>
      )}
      {plan && <PlanDialog planId={plan} onClose={() => setPlan(null)} />}
    </div>
  )
}
