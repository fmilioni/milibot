import { type Bot, type Routine } from '@milibot/shared'
import { CalendarClock, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBotRoutines } from '@/features/bots/api'
import { useAppStore } from '@/features/workspace/store'
import { Spinner } from '@/ui/Spinner'

import { RoutineEditor } from './RoutineEditor'
import { RoutineItem } from './RoutineItem'

export function BotRoutinesSection({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const routines = useBotRoutines(workspaceId, bot.id).data
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const ref = useRef<HTMLElement>(null)
  const focused = useAppStore((s) => s.panelSection === 'routines')
  useEffect(() => {
    if (!focused) return
    const timer = setTimeout(() => {
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      useAppStore.getState().clearPanelSection()
    }, 80)
    return () => clearTimeout(timer)
  }, [focused])
  return (
    <section ref={ref} className="flex scroll-mt-4 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-secondary">{t('panels.bot.routines')}</h3>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="focus-ring flex items-center gap-1 rounded text-sm text-accent hover:underline"
        >
          <Plus size={12} />
          {t('panels.bot.routine.add')}
        </button>
      </div>
      {routines === null ? (
        <Spinner className="text-fg-muted" />
      ) : routines.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted">
          <CalendarClock size={15} className="shrink-0" />
          {t('panels.bot.noRoutines')}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {routines.map((routine) => (
              <RoutineItem key={routine.id} routine={routine} bot={bot} onEdit={() => setEditing(routine)} />
            ))}
          </ul>
          <span className="text-xs text-fg-muted">{t('panels.bot.routinesHint')}</span>
        </>
      )}
      {editing && (
        <RoutineEditor
          bot={bot}
          routine={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
