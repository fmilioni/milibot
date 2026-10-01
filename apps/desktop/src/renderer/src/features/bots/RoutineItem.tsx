import { ApiError, type Bot, type Routine } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { CalendarClock, Ellipsis, Pencil, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { deleteRoutine, runRoutine, updateRoutine } from '@/features/bots/api'
import { describeSchedule, describeWhen } from '@/features/bots/lib/routine-schedule'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Menu } from '@/ui/Menu'
import { Modal } from '@/ui/Modal'
import { Switch } from '@/ui/Switch'
import { Tooltip } from '@/ui/Tooltip'

function statusLine(routine: Routine, locale: string, t: TFunction): string {
  const schedule = describeSchedule(routine.cron, locale, t)
  if (!routine.enabled) return `${schedule} · ${t('panels.bot.routine.paused')}`
  const status =
    routine.lastStatus && routine.lastStatus !== 'ok'
      ? t(`panels.bot.routine.status.${routine.lastStatus}` as 'panels.bot.routine.status.error')
      : routine.nextRunAt
        ? t('panels.bot.routine.next', { when: describeWhen(routine.nextRunAt, locale, t) })
        : null
  return status ? `${schedule} · ${status}` : schedule
}

export function RoutineItem({ routine, bot, onEdit }: { routine: Routine; bot: Bot; onEdit: () => void }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const showToast = useAppStore((s) => s.showToast)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const failed = routine.enabled && (routine.lastStatus === 'error' || routine.lastStatus === 'skipped')

  const invalidates = workspaceId ? [queryKeys.routines(workspaceId, bot.id)] : []
  const updateMutation = useApiMutation(
    (patch: { enabled: boolean }) => updateRoutine(workspaceId ?? '', routine.id, patch),
    { invalidates },
  )
  const runMutation = useApiMutation(() => runRoutine(workspaceId ?? '', routine.id), {
    onSuccess: () => showToast('routineStarted'),
    errorToast: (err) =>
      err instanceof ApiError && (err.details as { reason?: string } | undefined)?.reason === 'spend_paused'
        ? 'routineSpendPaused'
        : 'error',
  })
  const removeMutation = useApiMutation(() => deleteRoutine(workspaceId ?? '', routine.id), { invalidates })
  const update = (patch: { enabled: boolean }) => {
    if (workspaceId) void updateMutation.run(patch)
  }
  const runNow = async () => {
    if (workspaceId) await runMutation.run()
  }
  const remove = async () => {
    setDeleting(false)
    if (workspaceId) await removeMutation.run()
  }

  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 py-2.5 pr-2 pl-3">
      <CalendarClock
        size={15}
        className={cn('shrink-0', routine.enabled ? 'text-accent' : 'text-fg-muted')}
      />
      <Tooltip content={routine.prompt}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('truncate text-base', routine.enabled ? 'text-fg' : 'text-fg-muted')}>
            {routine.name}
          </span>
          <span className={cn('truncate text-xs', failed ? 'text-warning' : 'text-fg-muted')}>
            {statusLine(routine, i18n.language, t)}
          </span>
        </span>
      </Tooltip>
      <Switch
        checked={routine.enabled}
        label={t('panels.bot.routine.toggle', { name: routine.name })}
        onChange={(enabled) => update({ enabled })}
      />
      <Tooltip content={t('panels.bot.routine.options', { name: routine.name })}>
        <button
          type="button"
          aria-label={t('panels.bot.routine.options', { name: routine.name })}
          aria-haspopup="menu"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.right - 190, y: rect.bottom + 4 })
          }}
          className="focus-ring shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg"
        >
          <Ellipsis size={15} />
        </button>
      </Tooltip>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          width={190}
          label={t('panels.bot.routine.options', { name: routine.name })}
          onClose={() => setMenu(null)}
          entries={[
            {
              key: 'edit',
              label: t('panels.bot.routine.edit'),
              icon: <Pencil size={13} />,
              onSelect: onEdit,
            },
            {
              key: 'run',
              label: t('panels.bot.routine.runNow'),
              icon: <Play size={13} />,
              disabled: routine.lastStatus === 'running',
              onSelect: () => void runNow(),
            },
            { type: 'separator', key: 'sep' },
            {
              key: 'delete',
              label: t('panels.bot.routine.delete'),
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      )}
      {deleting && (
        <Modal
          title={t('panels.bot.routine.deleteTitle')}
          description={t('panels.bot.routine.deleteConfirm', { name: routine.name, bot: bot.name })}
          width={380}
          onClose={() => setDeleting(false)}
        >
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setDeleting(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t('panels.bot.routine.delete')}
            </Button>
          </div>
        </Modal>
      )}
    </li>
  )
}
