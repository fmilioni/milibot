import type { Board } from '@milibot/shared'
import { SquareKanban } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { DatePicker } from '@/ui/DatePicker'
import { Modal } from '@/ui/Modal'
import { FieldLabel, TextArea, TextInput } from '@/ui/TextInput'

import { useBoardStore } from './store'

/** Creates a board, or edits the title, summary and due date of one. */
export function BoardDialog({
  board,
  onClose,
  onSaved,
}: {
  board?: Board
  onClose: () => void
  onSaved?: (board: Board) => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const createBoard = useBoardStore((s) => s.createBoard)
  const updateBoard = useBoardStore((s) => s.updateBoard)
  const [title, setTitle] = useState(board?.title ?? '')
  const [summary, setSummary] = useState(board?.summary ?? '')
  const [due, setDue] = useState(board?.dueDate ?? '')
  const [limit, setLimit] = useState(board?.doingLimit ? String(board.doingLimit) : '')
  const limitValue = limit.trim() ? Number(limit) : null
  const limitValid =
    limitValue === null || (Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 50)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!title.trim() || !limitValid || busy) return
    setBusy(true)
    try {
      const body = { title: title.trim(), summary: summary.trim(), dueDate: due || null }
      if (board) {
        await updateBoard(workspaceId, board.id, { ...body, doingLimit: limitValue })
        onClose()
      } else {
        const created = await createBoard(workspaceId, body)
        if (limitValue !== null) await updateBoard(workspaceId, created.id, { doingLimit: limitValue })
        onSaved?.(created)
      }
    } catch {
      showToast('error')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t(board ? 'boards.dialog.editTitle' : 'boards.dialog.newTitle')}
      width={480}
      onClose={onClose}
      icon={<SquareKanban size={16} />}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!title.trim() || !limitValid || busy}
            onClick={() => void save()}
          >
            {t(board ? 'boards.dialog.save' : 'boards.dialog.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="board-title">{t('boards.dialog.fields.title')}</FieldLabel>
          <TextInput
            id="board-title"
            data-autofocus
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="board-summary" hint={t('boards.dialog.fields.summaryHint')}>
            {t('boards.dialog.fields.summary')}
          </FieldLabel>
          <TextArea
            id="board-summary"
            rows={3}
            value={summary}
            maxLength={600}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
        <div className="flex gap-6">
          <div className="flex flex-col gap-1.5">
            <FieldLabel>{t('boards.dialog.fields.due')}</FieldLabel>
            <DatePicker
              className="w-44"
              label={t('boards.dialog.fields.due')}
              value={due || null}
              onChange={(value) => setDue(value ?? '')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="board-doing-limit">{t('boards.dialog.fields.doingLimit')}</FieldLabel>
            <TextInput
              id="board-doing-limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={50}
              value={limit}
              placeholder={t('boards.dialog.fields.doingLimitNone')}
              aria-invalid={!limitValid}
              aria-describedby="board-doing-limit-hint"
              onChange={(e) => setLimit(e.target.value)}
              className="w-36"
            />
          </div>
        </div>
        <p
          id="board-doing-limit-hint"
          className={cn('-mt-2 text-sm', limitValid ? 'text-fg-secondary' : 'text-danger-strong')}
        >
          {t('boards.dialog.fields.doingLimitHint')}
        </p>
      </form>
    </Modal>
  )
}
