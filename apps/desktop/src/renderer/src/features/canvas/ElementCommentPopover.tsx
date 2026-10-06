import { ChevronRight, SendHorizontal } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { type AnchorRect, placeNextTo } from '@/lib/floating'
import { handleDialogKeys } from '@/ui/dialog-keys'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'
import { Spinner } from '@/ui/Spinner'

/**
 * The comment box next to a picked element: its trail (click a parent to pick it), the text and Send.
 * Enter sends, Shift+Enter breaks the line, Escape and Cancel close it; Tab stays inside. A pointer down
 * outside it closes it too, except on the canvas (`keepOpen`), which picks elements itself.
 */
export function ElementCommentPopover({
  anchor,
  trail,
  onPick,
  onSend,
  onClose,
  keepOpen,
}: {
  /** The element's rect on screen (viewport pixels), read when placing. */
  anchor: () => AnchorRect
  /** From the page's top element down to the picked one (last). */
  trail: readonly { key: Element; label: string }[]
  onPick: (element: Element) => void
  /** Rejects when the message couldn't be sent. */
  onSend: (text: string) => Promise<void>
  onClose: () => void
  keepOpen: (target: Node) => boolean
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const { ref, position } = useAnchoredPosition((el, viewport) =>
    placeNextTo(anchor(), el.getBoundingClientRect(), viewport),
  )
  const tag = trail.at(-1)?.label ?? ''

  // Focus moves in, and back to where it was when the box closes.
  useLayoutEffect(() => {
    const previous = document.activeElement
    textarea.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const latest = useRef({ onClose, keepOpen })
  useLayoutEffect(() => {
    latest.current = { onClose, keepOpen }
  })
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || ref.current?.contains(target) || latest.current.keepOpen(target))
        return
      latest.current.onClose()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [ref])

  const typed = text.trim()
  const send = async () => {
    if (!typed || sending) return
    setSending(true)
    setFailed(false)
    try {
      await onSend(typed)
    } catch {
      setFailed(true)
      setSending(false)
      textarea.current?.focus({ preventScroll: true })
    }
  }

  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <FloatingPortal
      ref={ref}
      position={position}
      role="dialog"
      aria-label={t('canvas.comment.dialog', { tag })}
      onKeyDown={(event) => handleDialogKeys(event, ref.current, onClose)}
      className="z-menu flex w-[300px] flex-col gap-2 rounded-[10px] border border-border bg-surface-2 p-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      <nav aria-label={t('canvas.comment.trail')} className="flex flex-wrap items-center gap-0.5">
        {trail.map((item, i) => {
          const current = i === trail.length - 1
          return (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight size={11} className="text-fg-muted" aria-hidden />}
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => onPick(item.key)}
                className={cn(
                  'focus-ring rounded px-1 py-px font-mono text-xs leading-4',
                  current
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-fg-secondary hover:bg-surface-3',
                )}
              >
                {item.label}
              </button>
            </span>
          )
        })}
      </nav>
      <textarea
        ref={textarea}
        value={text}
        rows={3}
        aria-label={t('canvas.comment.placeholder')}
        placeholder={t('canvas.comment.placeholder')}
        disabled={sending}
        onChange={(event) => {
          setText(event.target.value)
          setFailed(false)
        }}
        onKeyDown={onTextKey}
        className="focus-ring max-h-40 min-h-16 resize-none rounded-lg border border-border bg-bg px-2.5 py-2 text-sm leading-5 text-fg placeholder:text-fg-muted"
      />
      {failed && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {t('canvas.comment.failed')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs leading-4 text-fg-muted">
          {t('canvas.comment.keys')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring h-7 rounded-lg px-2.5 text-sm text-fg-secondary hover:bg-surface-3"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={!typed || sending}
          onClick={() => void send()}
          className="focus-ring flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-sm font-semibold text-on-accent hover:bg-accent-strong disabled:cursor-default disabled:opacity-50"
        >
          {sending ? <Spinner size={12} /> : <SendHorizontal size={12} aria-hidden />}
          {t('canvas.comment.send')}
        </button>
      </div>
    </FloatingPortal>
  )
}
