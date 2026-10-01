import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from './Button'
import { Modal } from './Modal'
import { TextInput } from './TextInput'

/**
 * A name field with Cancel/Save. `onSave` failing keeps the dialog open with the text `errorText` gives
 * for that error; an unchanged or empty name just closes it.
 */
export function RenameDialog({
  title,
  label,
  initial,
  maxLength,
  selectStem = false,
  onSave,
  errorText,
  onClose,
}: {
  title: string
  label: string
  initial: string
  maxLength: number
  /** Select the name without its extension (files). */
  selectStem?: boolean
  onSave: (name: string) => Promise<unknown>
  errorText: (err: unknown) => string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const save = () => {
    if (busy) return
    if (!trimmed || trimmed === initial) return onClose()
    setBusy(true)
    setError(null)
    onSave(trimmed).then(onClose, (err: unknown) => {
      setError(errorText(err))
      setBusy(false)
    })
  }
  return (
    <Modal title={title} width={420} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <TextInput
            aria-label={label}
            value={name}
            maxLength={maxLength}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => {
              const dot = selectStem ? e.currentTarget.value.lastIndexOf('.') : -1
              e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length)
            }}
            data-autofocus
          />
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={!trimmed || busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
