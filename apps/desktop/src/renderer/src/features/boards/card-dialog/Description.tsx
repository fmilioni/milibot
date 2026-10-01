import type { Board, BoardCardDetail } from '@milibot/shared'
import { FileText } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renderAsset } from '@/features/boards/BoardParts'
import { Button } from '@/ui/Button'
import { Markdown } from '@/ui/Markdown'
import { SectionTitle } from '@/ui/SectionTitle'

import { MarkdownEditor } from './MarkdownEditor'

export function Description({
  board,
  detail,
  onSave,
}: {
  board: Board
  detail: BoardCardDetail
  onSave: (body: string) => Promise<unknown> | unknown
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle
        as="h3"
        icon={<FileText size={13} />}
        action={
          draft === null && (
            <button
              type="button"
              onClick={() => setDraft(detail.body)}
              className="focus-ring rounded text-sm font-semibold text-accent"
            >
              {t('boards.card.edit')}
            </button>
          )
        }
      >
        {t('boards.card.description')}
      </SectionTitle>
      {draft === null ? (
        detail.body.trim() ? (
          <Markdown text={detail.body} renderAsset={renderAsset} compact />
        ) : (
          <p className="text-base text-fg-muted">{t('boards.card.noDescription')}</p>
        )
      ) : (
        <>
          <MarkdownEditor board={board} value={draft} onChange={setDraft} rows={10} mono />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void Promise.resolve(onSave(draft)).then(() => setDraft(null))
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
