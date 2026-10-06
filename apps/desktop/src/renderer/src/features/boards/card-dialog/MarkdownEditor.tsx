import type { Board } from '@milibot/shared'
import { Bold, Code, Heading2, ImagePlus, Italic, Link, ListOrdered } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renderAsset } from '@/features/boards/BoardParts'
import { applyFormat, insertAtCaret, type MarkdownFormat } from '@/features/boards/lib/boards'
import { cn } from '@/lib/cn'
import { Markdown } from '@/ui/Markdown'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { IMAGE_TYPES, imageFiles, useImageUpload } from './use-image-upload'

const FORMATS: Array<{ format: MarkdownFormat; icon: typeof Bold }> = [
  { format: 'heading', icon: Heading2 },
  { format: 'bold', icon: Bold },
  { format: 'italic', icon: Italic },
  { format: 'list', icon: ListOrdered },
  { format: 'code', icon: Code },
  { format: 'link', icon: Link },
]

/**
 * Markdown text with images: pasted, dropped or picked images upload and land at the caret. `full` adds the
 * Write/Preview tabs and the formatting bar; `composer` (comments) keeps a bare field whose footer the caller
 * fills next to the image button.
 */
export function MarkdownEditor({
  board,
  value,
  onChange,
  rows,
  placeholder,
  onSubmit,
  variant = 'full',
  footer,
  label,
}: {
  board: Board
  value: string
  onChange: (value: string) => void
  rows: number
  placeholder?: string
  onSubmit?: () => void
  variant?: 'full' | 'composer'
  /** Right side of the composer's footer (hint and send button). */
  footer?: React.ReactNode
  label: string
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTextAreaElement>(null)
  const pick = useRef<HTMLInputElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const { uploading, current, upload } = useImageUpload(board)
  // The text typed while an upload runs, so the image lands in what is there when it finishes.
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
  }, [value])

  const addImages = async (files: File[]) => {
    const caret = ref.current?.selectionStart ?? latest.current.length
    const markdown = await upload(files)
    if (!markdown.length) return
    const next = insertAtCaret(latest.current, caret, markdown.join('\n'))
    onChange(next.text)
    requestAnimationFrame(() => ref.current?.setSelectionRange(next.caret, next.caret))
  }
  const onPaste = (e: ClipboardEvent) => {
    const files = imageFiles(e.clipboardData.files)
    if (!files.length) return
    e.preventDefault()
    void addImages(files)
  }
  const onDrop = (e: DragEvent) => {
    const files = imageFiles(e.dataTransfer.files)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    void addImages(files)
  }
  const format = (kind: MarkdownFormat) => {
    const el = ref.current
    const next = applyFormat(
      value,
      el?.selectionStart ?? value.length,
      el?.selectionEnd ?? value.length,
      kind,
    )
    onChange(next.text)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(next.start, next.end)
    })
  }
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const next =
      e.key === 'Home' ? 'write' : e.key === 'End' ? 'preview' : tab === 'write' ? 'preview' : 'write'
    setTab(next)
    tabs.current[next === 'write' ? 0 : 1]?.focus()
  }

  const imageButton = (withText: boolean) => (
    <Tooltip content={withText ? null : t('boards.card.editor.image')}>
      <button
        type="button"
        aria-label={withText ? undefined : t('boards.card.editor.image')}
        onClick={() => pick.current?.click()}
        className={cn(
          'focus-ring hit flex h-7 shrink-0 items-center rounded-md text-fg-secondary hover:bg-surface-3 hover:text-fg',
          withText ? 'gap-1.5 px-2 text-sm font-medium' : 'w-7 justify-center',
        )}
      >
        <ImagePlus size={withText ? 14 : 16} aria-hidden />
        {withText && t('boards.card.editor.image')}
      </button>
    </Tooltip>
  )
  const fileInput = (
    <input
      ref={pick}
      type="file"
      accept={IMAGE_TYPES.join(',')}
      multiple
      hidden
      onChange={(e) => {
        void addImages(imageFiles(e.target.files))
        e.target.value = ''
      }}
    />
  )
  const uploadStatus = uploading && (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-secondary">
      <Spinner size={13} className="shrink-0 text-accent" />
      <span className="truncate">
        {t('boards.card.uploading')}
        {current && <span className="ml-1 text-fg">{current}</span>}
      </span>
    </span>
  )
  const field = (
    <textarea
      ref={ref}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onSubmit()
        }
      }}
      className={cn(
        'selectable block w-full bg-transparent px-3 text-fg outline-none placeholder:text-fg-secondary',
        variant === 'full'
          ? 'resize-y py-2.5 font-mono text-code leading-[1.7]'
          : 'max-h-60 min-h-10 resize-none pt-2.5 pb-1 text-base leading-[1.5] [field-sizing:content]',
      )}
    />
  )

  if (variant === 'composer')
    return (
      <div className="flex flex-col rounded-card border border-border bg-surface-2 focus-within:border-accent">
        {field}
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
          {imageButton(false)}
          {uploadStatus}
          <span className="flex-1" />
          {footer}
        </div>
        {fileInput}
      </div>
    )

  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface-2 focus-within:border-accent">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-surface px-1.5 py-1">
        <div
          role="tablist"
          aria-label={t('boards.card.editor.tabs')}
          className="flex gap-0.5 rounded-lg bg-surface-3 p-0.5"
        >
          {(['write', 'preview'] as const).map((value, i) => (
            <button
              key={value}
              ref={(el) => {
                tabs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`editor-tab-${value}`}
              aria-selected={tab === value}
              aria-controls={`editor-panel-${value}`}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={onTabKey}
              className={cn(
                'focus-ring hit h-6 rounded-[6px] px-2.5 text-sm',
                tab === value
                  ? 'bg-surface-2 font-semibold text-fg shadow-sm'
                  : 'text-fg-secondary hover:text-fg',
              )}
            >
              {t(`boards.card.editor.${value}`)}
            </button>
          ))}
        </div>
        <div
          role="toolbar"
          aria-label={t('boards.card.editor.toolbar')}
          className="ml-2 flex items-center gap-0.5"
        >
          {FORMATS.map(({ format: kind, icon: Icon }) => (
            <Tooltip key={kind} content={t(`boards.card.editor.${kind}`)}>
              <button
                type="button"
                aria-label={t(`boards.card.editor.${kind}`)}
                disabled={tab !== 'write'}
                onClick={() => format(kind)}
                className="focus-ring hit flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 hover:text-fg disabled:opacity-40"
              >
                <Icon size={14} aria-hidden />
              </button>
            </Tooltip>
          ))}
        </div>
        <span className="flex-1" />
        {imageButton(true)}
      </div>
      <div
        role="tabpanel"
        id={`editor-panel-${tab}`}
        aria-labelledby={`editor-tab-${tab}`}
        className="min-h-0"
      >
        {tab === 'write' ? (
          field
        ) : (
          <div className="min-h-[160px] px-3 py-2.5">
            {value.trim() ? (
              <Markdown text={value} renderAsset={renderAsset} compact />
            ) : (
              <p className="text-base text-fg-secondary">{t('boards.card.editor.nothingToPreview')}</p>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
        {uploadStatus}
        <span className="flex-1" />
        <span className="shrink-0 text-xs text-fg-secondary">{t('boards.card.editor.hint')}</span>
      </div>
      {fileInput}
    </div>
  )
}
