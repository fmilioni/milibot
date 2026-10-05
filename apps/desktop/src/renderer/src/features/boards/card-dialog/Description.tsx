import type { Board, BoardCardDetail } from '@milibot/shared'
import { FilePen, FileText, Pencil } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renderAsset } from '@/features/boards/BoardParts'
import { Button } from '@/ui/Button'
import { Markdown } from '@/ui/Markdown'

import { MarkdownEditor } from './MarkdownEditor'

/** A section title of the card's main column, with a rule under it. */
export function SectionHeading({
  icon,
  children,
  extra,
  action,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  extra?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-border pb-2">
      <span className="flex text-fg-secondary">{icon}</span>
      <h3 className="text-lg font-semibold text-fg">{children}</h3>
      {extra}
      <span className="flex-1" />
      {action}
    </div>
  )
}

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
  const [saving, setSaving] = useState(false)
  const save = () => {
    if (draft === null) return
    setSaving(true)
    void Promise.resolve(onSave(draft))
      .then(() => setDraft(null))
      .finally(() => setSaving(false))
  }
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        icon={<FileText size={18} aria-hidden />}
        extra={
          draft !== null && <span className="text-sm text-fg-secondary">· {t('boards.card.editing')}</span>
        }
        action={
          draft === null &&
          detail.body.trim() && (
            <button
              type="button"
              onClick={() => setDraft(detail.body)}
              className="focus-ring hit flex h-8 items-center gap-1.5 rounded-md px-2 text-base font-semibold text-accent-strong hover:bg-accent-soft"
            >
              <Pencil size={15} aria-hidden />
              {t('boards.card.edit')}
            </button>
          )
        }
      >
        {t('boards.card.description')}
      </SectionHeading>
      {draft === null ? (
        detail.body.trim() ? (
          <div className="max-w-[68ch] text-md leading-[1.6] text-fg">
            <Markdown text={detail.body} renderAsset={renderAsset} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-fg-muted/60 px-6 py-8 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-surface-3 text-fg-secondary">
              <FilePen size={18} aria-hidden />
            </span>
            <span className="text-md font-semibold text-fg">{t('boards.card.noDescriptionTitle')}</span>
            <span className="max-w-[420px] text-base text-fg-secondary">
              {t('boards.card.noDescriptionHint')}
            </span>
            <Button size="lg" variant="outline" className="mt-2" onClick={() => setDraft('')}>
              <Pencil size={14} aria-hidden />
              {t('boards.card.writeDescription')}
            </Button>
          </div>
        )
      ) : (
        <>
          <MarkdownEditor
            board={board}
            value={draft}
            onChange={setDraft}
            rows={12}
            label={t('boards.card.description')}
          />
          <div className="flex justify-end gap-2">
            <Button size="lg" variant="outline" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" variant="primary" disabled={saving} onClick={save}>
              {t('boards.card.saveDescription')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
