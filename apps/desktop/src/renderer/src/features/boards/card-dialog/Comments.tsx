import type { Board, BoardCardDetail } from '@milibot/shared'
import { MessageSquare, SendHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renderAsset } from '@/features/boards/BoardParts'
import { UserAvatar } from '@/features/boards/CardPeople'
import { useBoardStore } from '@/features/boards/store'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatRelative } from '@/lib/format'
import { shortcutLabel } from '@/lib/platform'
import { Markdown } from '@/ui/Markdown'
import { Tooltip } from '@/ui/Tooltip'

import { SectionHeading } from './Description'
import { MarkdownEditor } from './MarkdownEditor'

const AVATAR = 28

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
    <section className="flex flex-col gap-4">
      <SectionHeading
        icon={<MessageSquare size={14} aria-hidden />}
        extra={
          detail.comments.length > 0 && (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface-3 px-1.5 text-2xs font-semibold text-fg-secondary tabular-nums">
              {detail.comments.length}
            </span>
          )
        }
      >
        {t('boards.card.comments')}
      </SectionHeading>
      {detail.comments.length === 0 && (
        <p className="text-sm text-fg-secondary">{t('boards.card.noComments')}</p>
      )}
      {detail.comments.map((comment) => {
        const bot = comment.authorBotId ? bots[comment.authorBotId] : undefined
        return (
          <article key={comment.id} className="group flex gap-3">
            <span className="flex w-7 shrink-0 justify-center">
              {bot ? (
                <BotAvatar avatar={bot.avatar} state={bot.status} size={AVATAR} animated={false} />
              ) : (
                <UserAvatar size={AVATAR} ring={comment.authorType === 'user'} />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg">
                  {bot?.name ?? (comment.authorType === 'user' ? t('boards.card.you') : '…')}
                </span>
                <span className="text-xs text-fg-secondary">
                  {formatRelative(comment.createdAt, i18n.language, now, t('time.now'))}
                </span>
                <span className="flex-1" />
                {comment.authorType === 'user' && (
                  <Tooltip content={t('boards.card.deleteComment')}>
                    <button
                      type="button"
                      aria-label={t('boards.card.deleteComment')}
                      onClick={() =>
                        void toastOnError(deleteComment(workspaceId, board.id, detail.id, comment.id)).then(
                          onChanged,
                        )
                      }
                      className="focus-ring hit flex size-7 items-center justify-center rounded-md text-fg-secondary opacity-0 group-hover:opacity-100 hover:text-danger-strong focus-visible:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>
              <div className="max-w-[72ch] text-fg [&_.markdown]:leading-[1.55]">
                <Markdown text={comment.body} renderAsset={renderAsset} compact />
              </div>
            </div>
          </article>
        )
      })}
      <div className="flex items-start gap-3 pt-1">
        <span className="flex w-7 shrink-0 justify-center">
          <UserAvatar size={AVATAR} ring />
        </span>
        <div className="min-w-0 flex-1">
          <MarkdownEditor
            board={board}
            value={draft}
            onChange={setDraft}
            rows={1}
            variant="composer"
            label={t('boards.card.commentPlaceholder')}
            placeholder={t('boards.card.commentPlaceholder')}
            onSubmit={send}
            footer={
              <>
                <span className="hidden truncate text-xs text-fg-secondary sm:inline">
                  {t('boards.card.commentHint', { shortcut: shortcutLabel('Enter') })}
                </span>
                <button
                  type="button"
                  disabled={!draft.trim() || busy}
                  onClick={send}
                  className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent disabled:bg-surface-3 disabled:text-fg-secondary"
                >
                  <SendHorizontal size={14} aria-hidden />
                  {t('boards.card.comment')}
                </button>
              </>
            }
          />
        </div>
      </div>
    </section>
  )
}
