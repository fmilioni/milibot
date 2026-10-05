import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { shortcutLabel } from '@/lib/platform'

/**
 * Text that turns into a field on click: Enter saves (⌘/Ctrl+Enter when `multiline`), Esc cancels, blur saves.
 * While editing it shows how to save and the characters left.
 */
export function EditableLine({
  value,
  label,
  placeholder,
  className,
  max,
  multiline = false,
  onSave,
}: {
  value: string
  label: string
  /** Shown as "+ placeholder" when empty. */
  placeholder?: string
  className: string
  max: number
  multiline?: boolean
  onSave: (value: string) => void
}) {
  const { t } = useTranslation()
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
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        aria-label={value ? `${label}: ${value}` : label}
        className={cn(
          'focus-ring -mx-2 rounded-lg px-2 py-1 text-left break-words hover:bg-surface-3',
          className,
          !value && 'flex items-center gap-2 text-fg-secondary',
        )}
      >
        {value || (
          <>
            <Plus size={16} aria-hidden />
            {placeholder}
          </>
        )}
      </button>
    )
  const shared = {
    autoFocus: true,
    value: draft,
    maxLength: max,
    'aria-label': label,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: finish,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        finish()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDraft(value)
        setEditing(false)
      }
    },
    className: cn(
      'selectable -mx-2 w-[calc(100%+16px)] rounded-lg border border-accent bg-surface-2 px-2 py-1 text-fg outline-none ring-4 ring-accent-soft',
      className,
    ),
  }
  return (
    <div className="flex flex-col gap-1">
      {multiline ? <textarea rows={3} {...shared} /> : <input {...shared} />}
      <span className="flex justify-between text-xs text-fg-secondary">
        <span>
          {multiline
            ? t('boards.card.saveHintMultiline', { shortcut: shortcutLabel('Enter') })
            : t('boards.card.saveHint')}
        </span>
        <span className="tabular-nums">
          {draft.length}/{max}
        </span>
      </span>
    </div>
  )
}
