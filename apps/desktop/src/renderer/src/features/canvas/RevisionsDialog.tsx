import type { Bot, DesignFrame } from '@milibot/shared'
import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { revisionKind } from '@/features/canvas/lib/canvas'
import { useAppStore } from '@/features/workspace/store'
import { formatClock, formatDay } from '@/lib/format'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'

import { useDesignStore } from './store'

/** "Previous versions" of a frame: each state it had, newest first, with "Restore". */
export function RevisionsDialog({
  workspaceId,
  designId,
  frame,
  bots,
  onClose,
}: {
  workspaceId: string
  designId: string
  frame: DesignFrame
  bots: Record<string, Bot>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const revisions = useDesignStore((s) => s.revisions[designId])
  const loadRevisions = useDesignStore((s) => s.loadRevisions)
  const restoreRevision = useDesignStore((s) => s.restoreRevision)
  const showToast = useAppStore((s) => s.showToast)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    void loadRevisions(workspaceId, designId)
  }, [loadRevisions, workspaceId, designId])

  const restore = async (revisionId: string) => {
    setRestoring(revisionId)
    try {
      await restoreRevision(workspaceId, designId, revisionId)
      showToast('designRestored')
      onClose()
    } catch {
      showToast('error')
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Modal
      title={t('canvas.revisions.title', { name: frame.name })}
      description={t('canvas.revisions.description')}
      width={520}
      onClose={onClose}
      closeLabel={t('common.close')}
      icon={<History size={16} />}
    >
      <AsyncView
        data={revisions?.data}
        error={revisions?.error}
        onRetry={() => void loadRevisions(workspaceId, designId)}
        errorText={t('canvas.revisions.failed')}
      >
        {(all) => {
          const list = all.filter((r) => r.frameId === frame.id)
          if (list.length === 0)
            return <p className="py-4 text-center text-base text-fg-muted">{t('canvas.revisions.empty')}</p>
          return (
            <ol className="-mx-2 flex max-h-[min(420px,55vh)] flex-col overflow-y-auto">
              {list.map((revision, i) => {
                const bot = revision.authorBotId ? bots[revision.authorBotId] : undefined
                const author = revision.authorType === 'user' ? t('canvas.revisions.you') : (bot?.name ?? '…')
                const when = `${formatDay(revision.createdAt, i18n.language, t)} ${formatClock(revision.createdAt, i18n.language)}`
                const kind = revisionKind(revision.summary)
                return (
                  <li
                    key={revision.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface"
                  >
                    {bot ? (
                      <BotAvatar avatar={bot.avatar} state="idle" size={22} />
                    ) : (
                      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-2xs font-semibold text-fg-secondary">
                        {author.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-base text-fg">
                        {t(`canvas.revisions.kinds.${kind}`)}
                      </span>
                      <span className="truncate text-xs text-fg-muted">
                        {t('canvas.revisions.by', { author, when })}
                      </span>
                    </div>
                    {i === 0 ? (
                      <span className="shrink-0 rounded-md bg-surface-3 px-2 py-0.5 text-xs text-fg-secondary">
                        {t('canvas.revisions.current')}
                      </span>
                    ) : kind === 'deleted' ? null : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={restoring !== null}
                        onClick={() => void restore(revision.id)}
                      >
                        {restoring === revision.id
                          ? t('canvas.revisions.restoring')
                          : t('canvas.revisions.restore')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ol>
          )
        }}
      </AsyncView>
    </Modal>
  )
}
