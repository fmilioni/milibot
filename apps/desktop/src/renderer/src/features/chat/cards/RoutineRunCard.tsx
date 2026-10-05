import type { RoutineRunPayload } from '@milibot/shared'
import { CalendarClock } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LinkifiedText } from '@/ui/LinkifiedText'

/** "Routine: <name>" when a routine runs; the instructions the bot got stay folded until asked for. */
export function RoutineRunCard({ payload }: { payload: RoutineRunPayload }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-center gap-2 px-6">
      <div className="flex items-center justify-center gap-1.5 text-center text-sm text-fg-muted">
        <CalendarClock size={12} className="shrink-0" />
        <span>{t(payload.late ? 'chat.routine.runLate' : 'chat.routine.run', { name: payload.name })}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="focus-ring rounded font-medium text-fg-secondary hover:underline"
        >
          {t(open ? 'chat.routine.hideInstructions' : 'chat.routine.showInstructions')}
        </button>
      </div>
      {open && (
        <div className="selectable w-full max-w-[560px] rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 text-sm leading-[1.5] break-words whitespace-pre-wrap text-fg-secondary">
          <LinkifiedText text={payload.prompt} />
        </div>
      )}
    </div>
  )
}
