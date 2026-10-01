import type { MemoryNote } from '@milibot/shared'
import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

import { NoteEditor } from './NoteEditor'

export function NoteItem({
  note,
  pinnable = false,
  onPin,
  onSave,
  onDelete,
  extra,
}: {
  note: MemoryNote
  pinnable?: boolean
  onPin?: (pinned: boolean) => Promise<void>
  onSave: (content: string) => Promise<void>
  onDelete: () => Promise<void>
  /** Controls shown before the edit button. */
  extra?: ReactNode
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <li className="border-b border-border bg-surface-2 p-2.5 last:border-0">
        <NoteEditor
          initial={note.content}
          onCancel={() => setEditing(false)}
          onSave={(content) => onSave(content).then(() => setEditing(false))}
        />
      </li>
    )
  }
  const iconButton = 'focus-ring rounded p-1 text-fg-muted hover:text-fg'
  return (
    <li className="group flex items-start gap-2 border-b border-border bg-surface-2 px-2.5 py-2 last:border-0">
      {pinnable && (
        <Tooltip content={note.pinned ? t('memory.unpin') : t('memory.pin')}>
          <button
            type="button"
            aria-pressed={note.pinned}
            aria-label={note.pinned ? t('memory.unpin') : t('memory.pin')}
            onClick={() => void onPin?.(!note.pinned)}
            className={cn(
              'focus-ring mt-px rounded p-0.5',
              note.pinned ? 'text-accent' : 'text-fg-muted hover:text-fg',
            )}
          >
            {note.pinned ? <Pin size={12} /> : <PinOff size={12} />}
          </button>
        </Tooltip>
      )}
      <span className="selectable min-w-0 flex-1 text-sm leading-[17px] break-words whitespace-pre-wrap text-fg">
        {note.content}
      </span>
      {extra}
      <Tooltip content={t('memory.edit')}>
        <button
          type="button"
          aria-label={t('memory.edit')}
          onClick={() => setEditing(true)}
          className={iconButton}
        >
          <Pencil size={12} />
        </button>
      </Tooltip>
      <Tooltip content={t('memory.delete')}>
        <button
          type="button"
          aria-label={t('memory.delete')}
          onClick={() => void onDelete()}
          className="focus-ring rounded p-1 text-fg-muted hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      </Tooltip>
    </li>
  )
}
