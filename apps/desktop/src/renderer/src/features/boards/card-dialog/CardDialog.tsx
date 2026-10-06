import {
  type Board,
  BOARD_CARD_STATUSES,
  type BoardCard,
  type BoardCardStatus,
  columnCards,
} from '@milibot/shared'
import { ChevronDown, Copy, FolderInput, SquareKanban, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { CARD_TONE } from '@/features/boards/lib/boards'
import { useBoardStore } from '@/features/boards/store'
import { copyWithToast, toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { TONE_FILL } from '@/lib/tone'
import { ConfirmDialog } from '@/ui/Confirm'
import { Menu } from '@/ui/Menu'
import { Modal } from '@/ui/Modal'
import { MoreMenu } from '@/ui/MoreMenu'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { CardDetails } from './CardDetails'
import { Comments } from './Comments'
import { Description } from './Description'
import { EditableLine } from './EditableLine'
import { Links } from './Links'
import { SessionChanges } from './SessionChanges'

/** The pill of each status: tint and text that keeps AA. */
const STATUS_PILL: Record<BoardCardStatus, string> = {
  todo: 'bg-surface-3 text-fg',
  doing: 'bg-accent-soft text-accent-strong',
  done: 'bg-success-soft text-success-strong',
  dropped: 'bg-danger-tint text-danger-strong',
}

/** The card's status as a pill that opens the list of columns. */
function StatusPill({
  status,
  onChange,
}: {
  status: BoardCardStatus
  onChange: (s: BoardCardStatus) => void
}) {
  const { t } = useTranslation()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={`${t('boards.card.status')}: ${t(`boards.columns.${status}`)}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setAt({ x: rect.left, y: rect.bottom + 4 })
        }}
        className={cn(
          'focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-2 pl-2.5 text-sm font-semibold',
          STATUS_PILL[status],
        )}
      >
        <span className={`size-1.5 rounded-full ${TONE_FILL[CARD_TONE[status]]}`} aria-hidden />
        {t(`boards.columns.${status}`)}
        <ChevronDown size={14} aria-hidden />
      </button>
      {at && (
        <Menu
          x={at.x}
          y={at.y}
          width={200}
          label={t('boards.card.status')}
          onClose={() => setAt(null)}
          entries={BOARD_CARD_STATUSES.map((value) => ({
            key: value,
            label: t(`boards.columns.${value}`),
            checked: value === status,
            icon: <span className={`size-2 rounded-full ${TONE_FILL[CARD_TONE[value]]}`} aria-hidden />,
            onSelect: () => onChange(value),
          }))}
        />
      )}
    </>
  )
}

/**
 * A card: status, title and summary, description with images, the linked session's changes and comments; on
 * the side its details (assignees, labels, due date), links and who created it.
 */
export function CardDialog({
  board,
  cardId,
  liveBot = null,
  onClose,
  onMove,
}: {
  board: Board
  cardId: string
  liveBot?: string | null
  onClose: () => void
  onMove: (card: BoardCard) => void
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const card = useBoardStore((s) => s.cards[board.id]?.find((c) => c.id === cardId))
  const cards = useBoardStore((s) => s.cards[board.id])
  const cardDetail = useBoardStore((s) => s.cardDetail)
  const updateCard = useBoardStore((s) => s.updateCard)
  const moveCard = useBoardStore((s) => s.moveCard)
  const deleteCard = useBoardStore((s) => s.deleteCard)
  const [deleting, setDeleting] = useState(false)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const now = useNow(60_000)
  const { data: detail, reload } = useApiQuery(queryKeys.boardCard(workspaceId, board.id, cardId), () =>
    cardDetail(workspaceId, board.id, cardId),
  )

  useEffect(() => {
    if (cards && !card) onClose()
  }, [cards, card, onClose])

  if (!card) return null
  const author = card.createdByBotId ? bots[card.createdByBotId]?.name : null
  const liveName = liveBot ? bots[liveBot]?.name : null
  const save = (patch: Parameters<typeof updateCard>[3]) =>
    toastOnError(updateCard(workspaceId, board.id, cardId, patch).then(reload))
  const setStatus = (status: BoardCardStatus) =>
    status !== card.status &&
    toastOnError(moveCard(workspaceId, board.id, cardId, status, columnCards(cards ?? [], status).length))
  const fresh = card.updatedAt - card.createdAt < 60_000
  const when = formatRelative(fresh ? card.createdAt : card.updatedAt, i18n.language, now, t('time.now'))
  const sessions = detail?.links.filter((l) => l.kind === 'session') ?? []

  return (
    <Modal title={card.title} width={960} height={860} header={false} padded={false} onClose={onClose}>
      <span className={`h-1 shrink-0 ${TONE_FILL[CARD_TONE[card.status]]}`} aria-hidden />
      <div className="flex min-h-0 flex-1">
        {/* The padding is inside the scroller: the sticky header of an open file in the changes sits flush at its top. */}
        <div ref={setScroller} className="scroll-slim flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col gap-6 px-8 pt-5 pb-8">
            <div className="flex flex-col gap-3">
              <span className="flex items-center gap-1.5 text-sm text-fg-secondary">
                <SquareKanban size={14} aria-hidden />
                <span className="truncate">{board.title}</span>
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <StatusPill status={card.status} onChange={(s) => void setStatus(s)} />
                <span className="text-sm text-fg-secondary">
                  {t(fresh ? 'boards.card.created' : 'boards.card.updated', { time: when })}
                </span>
                {liveBot && (
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-success-strong">
                    <span
                      className="size-2 animate-pulse rounded-full bg-success motion-reduce:animate-none"
                      aria-hidden
                    />
                    {t('boards.live', { name: liveName ?? '…' })}
                  </span>
                )}
              </div>
              <EditableLine
                key={`title-${card.updatedAt}`}
                value={card.title}
                label={t('boards.card.title')}
                max={120}
                className="text-3xl leading-[1.3] font-bold tracking-[-0.01em] text-fg"
                onSave={(title) => void (title && save({ title }))}
              />
              <EditableLine
                key={`summary-${card.updatedAt}`}
                value={card.summary}
                label={t('boards.card.summary')}
                placeholder={t('boards.card.addSummary')}
                max={600}
                className="text-base leading-[1.5] text-fg-secondary"
                multiline
                onSave={(summary) => void save({ summary })}
              />
            </div>
            {detail ? (
              <>
                <Description board={board} detail={detail} onSave={(body) => save({ body })} />
                {sessions.map((link) => (
                  <SessionChanges key={link.id} sessionId={link.ref} scrollParent={scroller} />
                ))}
                <Comments board={board} detail={detail} onChanged={reload} />
              </>
            ) : (
              <Spinner size={16} className="text-fg-secondary" />
            )}
          </div>
        </div>
        <aside className="scroll-slim flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface pt-3">
          <div className="flex shrink-0 justify-end gap-0.5 px-3">
            <MoreMenu
              size="md"
              label={t('boards.card.more', { title: card.title })}
              width={210}
              entries={[
                {
                  key: 'copy-id',
                  label: t('boards.card.copyId'),
                  icon: <Copy size={14} />,
                  onSelect: () => copyWithToast(card.id, 'idCopied'),
                },
                {
                  key: 'move',
                  label: t('boards.card.moveTo'),
                  icon: <FolderInput size={14} />,
                  onSelect: () => onMove(card),
                },
                { type: 'separator', key: 'sep' },
                {
                  key: 'delete',
                  label: t('boards.card.delete'),
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
            <Tooltip content={t('common.close')}>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={onClose}
                className="focus-ring hit flex size-7 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-3 hover:text-fg"
              >
                <X size={16} />
              </button>
            </Tooltip>
          </div>
          <div className="flex flex-1 flex-col gap-6 px-5 pt-1 pb-5">
            <CardDetails board={board} card={card} onSave={(patch) => void save(patch)} />
            {detail && <Links board={board} detail={detail} onChanged={reload} />}
            <span className="flex-1" />
            <span className="border-t border-border pt-3 text-xs text-fg-secondary">
              {t(author ? 'boards.card.createdBy' : 'boards.card.createdByUser', {
                name: author,
                date: new Date(card.createdAt).toLocaleDateString(i18n.language),
              })}
            </span>
          </div>
        </aside>
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('boards.card.deleteTitle', { title: card.title })}
          description={t('boards.card.deleteDescription')}
          confirmLabel={t('boards.delete.confirm')}
          onConfirm={() => deleteCard(workspaceId, board.id, cardId)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Modal>
  )
}
