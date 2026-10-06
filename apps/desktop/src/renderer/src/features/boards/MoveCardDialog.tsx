import { BOARD_CARD_STATUSES, type BoardCard, type BoardCardStatus } from '@milibot/shared'
import { FolderInput } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { boardsIn } from '@/features/boards/lib/boards'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { Select } from '@/ui/Select'
import { FieldLabel } from '@/ui/TextInput'

import { useBoardStore } from './store'

/** Moves a card to another board (active boards first, then done ones), keeping its column unless changed. */
export function MoveCardDialog({
  card,
  onClose,
  onMoved,
}: {
  card: BoardCard
  onClose: () => void
  onMoved?: (boardId: string) => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const boards = useBoardStore((s) => s.boards)
  const moveCardToBoard = useBoardStore((s) => s.moveCardToBoard)
  const targets = [...boardsIn(boards, 'active'), ...boardsIn(boards, 'done')].filter(
    (b) => b.id !== card.boardId,
  )
  const [boardId, setBoardId] = useState(targets[0]?.id ?? '')
  const [status, setStatus] = useState<BoardCardStatus>(card.status)
  const [busy, setBusy] = useState(false)

  const move = async () => {
    if (!boardId || busy) return
    setBusy(true)
    try {
      await moveCardToBoard(workspaceId, card.boardId, card.id, { toBoardId: boardId, status })
      showToast('cardMoved')
      onClose()
      onMoved?.(boardId)
    } catch {
      showToast('error')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('boards.move.title')}
      description={t('boards.move.description', { title: card.title })}
      width={460}
      onClose={onClose}
      icon={<FolderInput size={16} />}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!boardId || busy} onClick={() => void move()}>
            {t('boards.move.confirm')}
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="text-base text-fg-secondary">{t('boards.move.noBoards')}</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="move-card-board">{t('boards.move.board')}</FieldLabel>
            <Select
              id="move-card-board"
              value={boardId}
              label={t('boards.move.board')}
              onChange={setBoardId}
              options={targets.map((b) => ({
                value: b.id,
                label: b.status === 'done' ? `${b.title} · ${t('boards.status.done')}` : b.title,
              }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="move-card-column">{t('boards.move.column')}</FieldLabel>
            <Select
              id="move-card-column"
              value={status}
              label={t('boards.move.column')}
              onChange={setStatus}
              options={BOARD_CARD_STATUSES.map((value) => ({ value, label: t(`boards.columns.${value}`) }))}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}
