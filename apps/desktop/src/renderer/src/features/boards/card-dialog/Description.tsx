import type { Board, BoardCardDetail } from '@milibot/shared'
import { FilePen, FileText, Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
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
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border">
      <span className="flex text-fg-secondary">{icon}</span>
      <h3 className="text-base font-semibold text-fg">{children}</h3>
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
  // Leaving the editor removes the focused button: focus goes back to the section so keys (Esc) still reach the dialog.
  const section = useRef<HTMLElement>(null)
  const close = () => {
    setDraft(null)
    requestAnimationFrame(() => section.current?.focus())
  }
  const save = () => {
    if (draft === null) return
    setSaving(true)
    void Promise.resolve(onSave(draft))
      .then(close)
      .finally(() => setSaving(false))
  }
  return (
    <section ref={section} tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <SectionHeading
        icon={<FileText size={14} aria-hidden />}
        extra={
          draft !== null && <span className="text-sm text-fg-secondary">· {t('boards.card.editing')}</span>
        }
        action={
          draft === null &&
          detail.body.trim() && (
            <button
              type="button"
              onClick={() => setDraft(detail.body)}
              className="focus-ring hit -mr-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-accent-strong hover:bg-accent-soft"
            >
              <Pencil size={12} aria-hidden />
              {t('boards.card.edit')}
            </button>
          )
        }
      >
        {t('boards.card.description')}
      </SectionHeading>
      {draft === null ? (
        detail.body.trim() ? (
          <div className="max-w-[72ch] text-fg [&_.markdown]:leading-[1.55]">
            <Markdown text={detail.body} renderAsset={renderAsset} compact />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2.5 rounded-card border border-dashed border-fg-muted/60 px-6 py-6 text-center">
            <span className="flex size-8 items-center justify-center rounded-full bg-surface-3 text-fg-secondary">
              <FilePen size={16} aria-hidden />
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-base font-semibold text-fg">{t('boards.card.noDescriptionTitle')}</span>
              <span className="max-w-[48ch] text-sm text-fg-secondary">
                {t('boards.card.noDescriptionHint')}
              </span>
            </span>
            <Button variant="outline" onClick={() => setDraft('')}>
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
            rows={8}
            label={t('boards.card.description')}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={save}>
              {t('boards.card.saveDescription')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
