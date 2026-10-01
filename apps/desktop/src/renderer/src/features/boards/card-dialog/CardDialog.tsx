import { type Board, BOARD_CARD_STATUSES, type BoardCardStatus, columnCards } from '@milibot/shared'
import { ChevronRight, GitCompare, Link2, SquareKanban, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { AssigneePicker, LabelPicker } from '@/features/boards/CardPeople'
import { CARD_TONE } from '@/features/boards/lib/boards'
import { useBoardStore } from '@/features/boards/store'
import { ChangesPane } from '@/features/sessions/ChangesPane'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatRelative } from '@/lib/format'
import { TONE_FILL, TONE_TEXT } from '@/lib/tone'
import { ConfirmDialog } from '@/ui/Confirm'
import { DatePicker } from '@/ui/DatePicker'
import { Modal } from '@/ui/Modal'
import { MoreMenu } from '@/ui/MoreMenu'
import { SectionTitle } from '@/ui/SectionTitle'
import { Select } from '@/ui/Select'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { Comments } from './Comments'
import { Description } from './Description'
import { EditableLine } from './EditableLine'
import { Links } from './Links'

/** A card: status, due date, description with images, links, the linked session's changes and comments. */
export function CardDialog({
  board,
  cardId,
  onClose,
}: {
  board: Board
  cardId: string
  onClose: () => void
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
  const save = (patch: Parameters<typeof updateCard>[3]) =>
    toastOnError(updateCard(workspaceId, board.id, cardId, patch).then(reload))
  const setStatus = (status: BoardCardStatus) =>
    status !== card.status &&
    toastOnError(moveCard(workspaceId, board.id, cardId, status, columnCards(cards ?? [], status).length))

  return (
    <Modal title={card.title} width={900} height={860} header={false} padded={false} onClose={onClose}>
      <header className="flex shrink-0 flex-col gap-2.5 border-b border-border px-6 pt-4 pb-4">
        <div className="flex items-center gap-1.5 text-sm text-fg-muted">
          <SquareKanban size={13} aria-hidden />
          <span className="truncate">{board.title}</span>
          <ChevronRight size={12} aria-hidden />
          <span className="flex-1" />
          <MoreMenu
            label={t('boards.card.more', { title: card.title })}
            width={180}
            entries={[
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
              className="focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <EditableLine
          key={`title-${card.updatedAt}`}
          value={card.title}
          label={t('boards.card.title')}
          className="text-4xl font-bold"
          onSave={(title) => title && save({ title })}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="w-40">
            <Select
              value={card.status}
              size="sm"
              label={t('boards.card.status')}
              onChange={setStatus}
              options={BOARD_CARD_STATUSES.map((status) => ({
                value: status,
                label: t(`boards.columns.${status}`),
              }))}
              renderValue={(option) => (
                <span
                  className={`flex items-center gap-1.5 font-semibold ${TONE_TEXT[CARD_TONE[card.status]]}`}
                >
                  <span
                    className={`size-[7px] rounded-full ${TONE_FILL[CARD_TONE[card.status]]}`}
                    aria-hidden
                  />
                  {option?.label}
                </span>
              )}
            />
          </span>
          <span className="flex items-center gap-1.5 text-sm text-fg-secondary">
            {t('boards.card.due')}
            <DatePicker
              size="sm"
              className="w-36"
              label={t('boards.card.due')}
              value={card.dueDate}
              onChange={(dueDate) => save({ dueDate })}
            />
          </span>
          <AssigneePicker value={card.assignees} onChange={(assignees) => save({ assignees })} />
          <LabelPicker board={board} value={card.labelIds} onChange={(labelIds) => save({ labelIds })} />
          <span className="text-sm text-fg-muted">
            {t('boards.card.updated', {
              time: formatRelative(card.updatedAt, i18n.language, now, t('time.now')),
            })}
          </span>
        </div>
        <EditableLine
          key={`summary-${card.updatedAt}`}
          value={card.summary}
          label={t('boards.card.summary')}
          placeholder={t('boards.card.summaryPlaceholder')}
          className="text-base text-fg-secondary"
          multiline
          onSave={(summary) => save({ summary })}
        />
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          ref={setScroller}
          className="scroll-slim flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
        >
          {detail ? (
            <>
              <Description board={board} detail={detail} onSave={(body) => save({ body })} />
              {detail.links
                .filter((l) => l.kind === 'session')
                .map((link) => (
                  <section key={link.id} className="flex flex-col gap-2">
                    <SectionTitle as="h3" icon={<GitCompare size={13} />}>
                      {t('boards.card.changes')}
                    </SectionTitle>
                    <div className="overflow-clip rounded-[10px] border border-border">
                      <ChangesPane sessionId={link.ref} scrollParent={scroller} />
                    </div>
                  </section>
                ))}
              <Comments board={board} detail={detail} onChanged={reload} />
            </>
          ) : (
            <Spinner size={16} className="text-fg-muted" />
          )}
        </div>
        <aside className="scroll-slim flex w-[270px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface px-4.5 py-5">
          <SectionTitle as="h3" icon={<Link2 size={13} />}>
            {t('boards.card.links')}
          </SectionTitle>
          {detail && <Links board={board} detail={detail} onChanged={reload} />}
          <span className="flex-1" />
          <span className="text-xs text-fg-muted">
            {t(author ? 'boards.card.createdBy' : 'boards.card.createdByUser', {
              name: author,
              date: new Date(card.createdAt).toLocaleDateString(i18n.language),
            })}
          </span>
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
