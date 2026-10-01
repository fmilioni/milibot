import { useState } from 'react'

import { cn } from '@/lib/cn'
import { TextArea, TextInput } from '@/ui/TextInput'

/** Text that turns into an input on click and saves on blur or Enter. */
export function EditableLine({
  value,
  label,
  placeholder,
  className,
  multiline = false,
  onSave,
}: {
  value: string
  label: string
  placeholder?: string
  className: string
  multiline?: boolean
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const finish = () => {
    setEditing(false)
    if (draft.trim() !== value) onSave(draft.trim())
  }
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={label}
        className={cn(
          'focus-ring -mx-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-3',
          className,
          !value && 'text-fg-muted',
        )}
      >
        {value || placeholder}
      </button>
    )
  const shared = {
    autoFocus: true,
    value: draft,
    'aria-label': label,
    placeholder,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: finish,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        finish()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDraft(value)
        setEditing(false)
      }
    },
  }
  return multiline ? (
    <TextArea rows={2} maxLength={600} className={className} {...shared} />
  ) : (
    <TextInput maxLength={120} className={`!h-9 ${className}`} {...shared} />
  )
}
