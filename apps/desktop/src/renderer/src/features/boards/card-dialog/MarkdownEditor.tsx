import type { Board } from '@milibot/shared'
import { ImagePlus } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { insertAtCaret } from '@/features/boards/lib/boards'
import { cn } from '@/lib/cn'
import { Spinner } from '@/ui/Spinner'
import { TextArea } from '@/ui/TextInput'

import { IMAGE_TYPES, imageFiles, useImageUpload } from './use-image-upload'

/** Markdown text with images: pasted, dropped or picked images upload and land at the caret. */
export function MarkdownEditor({
  board,
  value,
  onChange,
  rows,
  placeholder,
  onSubmit,
  mono = false,
}: {
  board: Board
  value: string
  onChange: (value: string) => void
  rows: number
  placeholder?: string
  onSubmit?: () => void
  mono?: boolean
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTextAreaElement>(null)
  const pick = useRef<HTMLInputElement>(null)
  const { uploading, upload } = useImageUpload(board)
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

  return (
    <div className="flex flex-col gap-1.5">
      <TextArea
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder}
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
        className={cn('resize-y', mono ? 'font-mono text-code' : 'text-base')}
      />
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <button
          type="button"
          onClick={() => pick.current?.click()}
          className="focus-ring flex items-center gap-1 rounded hover:text-fg-secondary"
        >
          <ImagePlus size={13} aria-hidden />
          {t('boards.card.addImage')}
        </button>
        {uploading && (
          <span className="flex items-center gap-1">
            <Spinner size={11} />
            {t('boards.card.uploading')}
          </span>
        )}
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
      </div>
    </div>
  )
}
