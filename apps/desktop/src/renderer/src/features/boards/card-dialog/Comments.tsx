import type { Board, BoardCardDetail } from '@milibot/shared'
import { MessageSquare, SendHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renderAsset } from '@/features/boards/BoardParts'
import { useBoardStore } from '@/features/boards/store'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatRelative } from '@/lib/format'
import { Markdown } from '@/ui/Markdown'
import { SectionTitle } from '@/ui/SectionTitle'
import { Tooltip } from '@/ui/Tooltip'

import { MarkdownEditor } from './MarkdownEditor'

export function Comments({
  board,
  detail,
  onChanged,
}: {
  board: Board
  detail: BoardCardDetail
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const addComment = useBoardStore((s) => s.addComment)
  const deleteComment = useBoardStore((s) => s.deleteComment)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const now = useNow(60_000)
  const send = () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    void toastOnError(addComment(workspaceId, board.id, detail.id, body))
      .then((comment) => {
        if (comment) setDraft('')
        onChanged()
      })
      .finally(() => setBusy(false))
  }
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle as="h3" icon={<MessageSquare size={13} />}>
        {detail.comments.length
          ? t('boards.card.commentsCount', { count: detail.comments.length })
          : t('boards.card.comments')}
      </SectionTitle>
      {detail.comments.map((comment) => {
        const bot = comment.authorBotId ? bots[comment.authorBotId] : undefined
        return (
          <div key={comment.id} className="group flex gap-2.5">
            {bot ? (
              <BotAvatar avatar={bot.avatar} state={bot.status} size={22} animated={false} />
            ) : (
              <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-2xs font-bold text-fg-secondary">
                {t('boards.card.you').slice(0, 1)}
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-fg">
                  {bot?.name ?? (comment.authorType === 'user' ? t('boards.card.you') : '…')}
                </span>
                <span className="text-xs text-fg-muted">
                  {formatRelative(comment.createdAt, i18n.language, now, t('time.now'))}
                </span>
                <span className="flex-1" />
                {comment.authorType === 'user' && (
                  <button
                    type="button"
                    aria-label={t('boards.card.deleteComment')}
                    onClick={() =>
                      void toastOnError(deleteComment(workspaceId, board.id, detail.id, comment.id)).then(
                        onChanged,
                      )
                    }
                    className="focus-ring rounded text-fg-muted opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <Markdown text={comment.body} renderAsset={renderAsset} compact />
            </div>
          </div>
        )
      })}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <MarkdownEditor
            board={board}
            value={draft}
            onChange={setDraft}
            rows={2}
            placeholder={t('boards.card.commentPlaceholder')}
            onSubmit={send}
          />
        </div>
        <Tooltip content={t('boards.card.send')}>
          <button
            type="button"
            aria-label={t('boards.card.send')}
            disabled={!draft.trim() || busy}
            onClick={send}
            className="focus-ring flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-accent text-on-accent disabled:opacity-50"
          >
            <SendHorizontal size={15} />
          </button>
        </Tooltip>
      </div>
    </section>
  )
}
