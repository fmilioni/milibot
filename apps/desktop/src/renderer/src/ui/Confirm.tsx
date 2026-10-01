import { TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from './Button'
import { Modal } from './Modal'
import { TextInput } from './TextInput'

/** A confirmation strip under a row: the question, then Cancel and a danger button on the right. */
export function InlineConfirm({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  message: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex basis-full flex-col gap-2 border-t border-border pt-2.5">
      <span className="min-w-0 text-sm text-fg-secondary">{message}</span>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * A confirmation dialog for a destructive action. With `typeToConfirm`, the button stays disabled until
 * that text is typed (`typeLabel` says what to type). `onConfirm` failing keeps the dialog open and
 * shows `errorText`.
 */
export function ConfirmDialog({
  title,
  description,
  body,
  confirmLabel,
  busyLabel,
  confirmIcon,
  onConfirm,
  onClose,
  typeToConfirm,
  typeLabel,
  errorText,
  width = 440,
}: {
  title: string
  description?: string
  /** Shown as a warning box above the buttons. */
  body?: ReactNode
  confirmLabel: string
  busyLabel?: string
  confirmIcon?: ReactNode
  onConfirm: () => Promise<unknown>
  onClose: () => void
  typeToConfirm?: string
  typeLabel?: string
  errorText?: string
  width?: number
}) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const matches = typeToConfirm === undefined || typed.trim() === typeToConfirm.trim()
  const submit = () => {
    if (!matches || busy) return
    setBusy(true)
    setFailed(false)
    onConfirm().then(
      () => setBusy(false),
      () => {
        setFailed(true)
        setBusy(false)
      },
    )
  }
  return (
    <Modal title={title} {...(description ? { description } : {})} width={width} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {body && (
          <div className="flex gap-3 rounded-[10px] bg-danger-tint px-3.5 py-3">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            <div className="text-base leading-[1.5] text-fg">{body}</div>
          </div>
        )}
        {typeToConfirm !== undefined && (
          <div className="flex flex-col gap-1.5">
            {typeLabel && <span className="text-sm font-medium text-fg-secondary">{typeLabel}</span>}
            <TextInput
              data-autofocus
              aria-label={typeLabel ?? typeToConfirm}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              className={typed && !matches ? 'border-danger-soft' : ''}
            />
          </div>
        )}
        {failed && <p className="text-sm text-danger">{errorText ?? t('toast.error')}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" type="submit" disabled={!matches || busy}>
            {confirmIcon}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
