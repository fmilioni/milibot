import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/ui/Button'
import { TextArea } from '@/ui/TextInput'

export function NoteEditor({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string
  placeholder?: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const save = () => {
    if (!value.trim() || busy) return
    setBusy(true)
    void onSave(value.trim()).finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col gap-2">
      <TextArea
        autoFocus
        tone="surface"
        rows={2}
        maxLength={4000}
        value={value}
        placeholder={placeholder}
        className="[field-sizing:content] min-h-[56px]"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={!value.trim() || busy} onClick={save}>
          {t('memory.save')}
        </Button>
      </div>
    </div>
  )
}
