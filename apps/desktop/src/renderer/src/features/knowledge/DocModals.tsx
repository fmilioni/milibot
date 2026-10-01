import type { KnowledgeDoc } from '@milibot/shared'
import { ChevronLeft, ChevronRight, FileText, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getKnowledgeContent } from '@/features/knowledge/api'
import { splitPages } from '@/features/knowledge/lib/knowledge'
import { toastOnError } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Button } from '@/ui/Button'
import { Markdown } from '@/ui/Markdown'
import { Modal } from '@/ui/Modal'
import { TextInput } from '@/ui/TextInput'

import { useKnowledgeStore } from './store'

/** "View content and summary": the summary, then the extracted text in parts, page by page. */
export function ContentModal({ doc, onClose }: { doc: KnowledgeDoc; onClose: () => void }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const [part, setPart] = useState(1)
  const {
    data: content,
    error,
    loading,
  } = useApiQuery(queryKeys.knowledgeContent(workspaceId, doc.id, part), () =>
    getKnowledgeContent(workspaceId, doc.id, part),
  )

  const summary = content?.summary ?? doc.summary
  const sections = content ? splitPages(content.text) : []
  const parts = content?.parts ?? 1

  return (
    <Modal title={doc.title} width={760} onClose={onClose} icon={<FileText size={17} />}>
      <section className="flex flex-col gap-1.5 rounded-xl bg-surface px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg-secondary">
          <Sparkles size={12} aria-hidden />
          {t('knowledge.content.summary')}
          {doc.summaryModel && (
            <span className="font-normal text-fg-muted">
              · {t('knowledge.content.summaryBy', { model: doc.summaryModel })}
            </span>
          )}
        </h3>
        <p className="selectable text-base leading-[1.5] text-fg">
          {summary || <span className="text-fg-muted">{t('knowledge.content.noSummary')}</span>}
        </p>
      </section>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg-secondary">{t('knowledge.content.content')}</h3>
        {parts > 1 && (
          <div className="flex items-center gap-1 text-sm text-fg-secondary">
            <button
              type="button"
              aria-label={t('knowledge.content.previous')}
              disabled={part <= 1}
              onClick={() => setPart((p) => Math.max(1, p - 1))}
              className="focus-ring flex size-6 items-center justify-center rounded-md hover:bg-surface-3 disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="tabular-nums">{t('knowledge.content.part', { part, parts })}</span>
            <button
              type="button"
              aria-label={t('knowledge.content.next')}
              disabled={part >= parts}
              onClick={() => setPart((p) => Math.min(parts, p + 1))}
              className="focus-ring flex size-6 items-center justify-center rounded-md hover:bg-surface-3 disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
      <div
        tabIndex={0}
        data-autofocus
        aria-label={t('knowledge.content.content')}
        className="focus-ring scroll-slim -mt-2 max-h-[52vh] min-h-[120px] overflow-y-auto rounded-xl border border-border bg-surface px-4 py-2"
      >
        {loading && !content ? (
          <p className="py-6 text-center text-base text-fg-muted">{t('knowledge.content.loading')}</p>
        ) : error && !loading ? (
          <p className="py-6 text-center text-base text-danger">{t('knowledge.content.error')}</p>
        ) : sections.length === 0 ? (
          <p className="py-6 text-center text-base text-fg-muted">{t('knowledge.content.empty')}</p>
        ) : (
          sections.map((section, i) => (
            <div key={`${part}-${i}`} className={loading ? 'opacity-60' : ''}>
              {section.page !== null && (
                <div className="sticky top-0 z-sticky -mx-4 mt-1 border-b border-border bg-surface/95 px-4 py-1 text-xs font-semibold text-fg-muted">
                  {t('knowledge.content.page', { page: section.page })}
                </div>
              )}
              <Markdown text={section.text} compact />
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

export function RenameModal({ doc, onClose }: { doc: KnowledgeDoc; onClose: () => void }) {
  const { t } = useTranslation()
  const updateDoc = useKnowledgeStore((s) => s.updateDoc)
  const workspaceId = useWorkspaceId()
  const [title, setTitle] = useState(doc.title)
  const trimmed = title.trim()
  const save = () => {
    if (!trimmed || trimmed === doc.title) return onClose()
    onClose()
    void toastOnError(updateDoc(workspaceId, doc.id, { title: trimmed }))
  }
  return (
    <Modal title={t('knowledge.rename.title')} width={420} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <TextInput
          aria-label={t('knowledge.rename.label')}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          data-autofocus
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={!trimmed}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function DeleteModal({ doc, onClose }: { doc: KnowledgeDoc; onClose: () => void }) {
  const { t } = useTranslation()
  const deleteDoc = useKnowledgeStore((s) => s.deleteDoc)
  const workspaceId = useWorkspaceId()
  return (
    <Modal
      title={t('knowledge.delete.title')}
      description={t('knowledge.delete.message', { name: doc.title })}
      width={440}
      onClose={onClose}
    >
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} data-autofocus>
          {t('common.cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose()
            void toastOnError(deleteDoc(workspaceId, doc.id))
          }}
        >
          {t('knowledge.delete.confirm')}
        </Button>
      </div>
    </Modal>
  )
}
