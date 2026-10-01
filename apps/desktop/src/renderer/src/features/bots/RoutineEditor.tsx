import { type Bot, formatTimeOfDay, type Routine } from '@milibot/shared'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { createRoutine, updateRoutine } from '@/features/bots/api'
import {
  describeSchedule,
  describeWhen,
  draftFromCron,
  draftToCron,
  FREQUENCIES,
  HOUR_STEPS,
  MINUTE_STEPS,
  parseTime,
  previewDraft,
  type ScheduleDraft,
} from '@/features/bots/lib/routine-schedule'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { Select } from '@/ui/Select'
import { FieldLabel, TextArea, TextInput } from '@/ui/TextInput'

export function RoutineEditor({
  bot,
  routine,
  onClose,
}: {
  bot: Bot
  routine: Routine | null
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromCron(routine?.cron ?? '0 9 * * *'))
  const saveMutation = useApiMutation(
    (body: { name: string; prompt: string; cron: string }) =>
      routine
        ? updateRoutine(workspaceId ?? '', routine.id, body)
        : createRoutine(workspaceId ?? '', bot.id, body),
    { invalidates: workspaceId ? [queryKeys.routines(workspaceId, bot.id)] : [], onSuccess: onClose },
  )
  const busy = saveMutation.busy
  const preview = useMemo(() => previewDraft(draft), [draft])
  const set = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const valid = name.trim() && prompt.trim() && 'runs' in preview

  const save = async () => {
    if (!workspaceId || !valid) return
    await saveMutation.run({ name: name.trim(), prompt: prompt.trim(), cron: draftToCron(draft) })
  }

  const short = t('routines.schedule.short', { returnObjects: true }) as unknown as string[]
  const timeField = (
    <div className="flex w-[120px] flex-col gap-1.5">
      <FieldLabel htmlFor="routine-time">{t('panels.bot.routine.time')}</FieldLabel>
      <TextInput
        id="routine-time"
        type="time"
        value={formatTimeOfDay(draft.time)}
        onChange={(e) => {
          const time = parseTime(e.target.value)
          if (time) set({ time })
        }}
      />
    </div>
  )

  return (
    <Modal
      title={routine ? t('panels.bot.routine.editTitle') : t('panels.bot.routine.newTitle')}
      width={560}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="routine-name">{t('panels.bot.routine.name')}</FieldLabel>
          <TextInput
            id="routine-name"
            data-autofocus
            value={name}
            maxLength={80}
            placeholder={t('panels.bot.routine.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="routine-prompt">{t('panels.bot.routine.prompt')}</FieldLabel>
          <TextArea
            id="routine-prompt"
            rows={3}
            maxLength={4000}
            className="max-h-60 min-h-[76px] [field-sizing:content]"
            value={prompt}
            placeholder={t('panels.bot.routine.promptPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-surface-2 p-3">
          <span className="text-sm font-medium text-fg-secondary">{t('panels.bot.routine.when')}</span>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[170px] flex-1 flex-col gap-1.5">
              <FieldLabel>{t('panels.bot.routine.frequency')}</FieldLabel>
              <Select
                label={t('panels.bot.routine.frequency')}
                value={draft.frequency}
                options={FREQUENCIES.map((f) => ({
                  value: f,
                  label: t(`panels.bot.routine.frequencies.${f}`),
                }))}
                onChange={(frequency) =>
                  set(frequency === 'custom' ? { frequency, cron: draftToCron(draft) } : { frequency })
                }
              />
            </div>
            {(draft.frequency === 'daily' ||
              draft.frequency === 'weekdays' ||
              draft.frequency === 'weekly') &&
              timeField}
            {draft.frequency === 'monthly' && (
              <>
                <div className="flex w-[110px] flex-col gap-1.5">
                  <FieldLabel>{t('panels.bot.routine.day')}</FieldLabel>
                  <Select
                    label={t('panels.bot.routine.day')}
                    value={String(draft.day)}
                    options={Array.from({ length: 28 }, (_, i) => ({
                      value: String(i + 1),
                      label: String(i + 1),
                    }))}
                    onChange={(day) => set({ day: Number(day) })}
                  />
                </div>
                {timeField}
              </>
            )}
            {draft.frequency === 'hourly' && (
              <div className="flex w-[170px] flex-col gap-1.5">
                <FieldLabel>{t('panels.bot.routine.every')}</FieldLabel>
                <Select
                  label={t('panels.bot.routine.every')}
                  value={String(draft.hours)}
                  options={HOUR_STEPS.map((n) => ({
                    value: String(n),
                    label: t('panels.bot.routine.everyHours', { count: n }),
                  }))}
                  onChange={(hours) => set({ hours: Number(hours) })}
                />
              </div>
            )}
            {draft.frequency === 'minutes' && (
              <div className="flex w-[170px] flex-col gap-1.5">
                <FieldLabel>{t('panels.bot.routine.every')}</FieldLabel>
                <Select
                  label={t('panels.bot.routine.every')}
                  value={String(draft.minutes)}
                  options={MINUTE_STEPS.map((n) => ({
                    value: String(n),
                    label: t('panels.bot.routine.everyMinutes', { count: n }),
                  }))}
                  onChange={(minutes) => set({ minutes: Number(minutes) })}
                />
              </div>
            )}
          </div>
          {draft.frequency === 'weekly' && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel>{t('panels.bot.routine.days')}</FieldLabel>
              <div className="flex gap-1.5" role="group" aria-label={t('panels.bot.routine.days')}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                  const on = draft.days.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          days: current.days.includes(d)
                            ? current.days.filter((x) => x !== d)
                            : [...current.days, d],
                        }))
                      }
                      className={cn(
                        'focus-ring h-7 min-w-[40px] rounded-md border px-2 text-sm capitalize',
                        on
                          ? 'border-accent bg-accent-soft font-semibold text-accent'
                          : 'border-border bg-surface text-fg-secondary hover:bg-surface-3',
                      )}
                    >
                      {short[d]}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {draft.frequency === 'custom' && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="routine-cron" hint={t('panels.bot.routine.cronHint')}>
                {t('panels.bot.routine.cron')}
              </FieldLabel>
              <TextInput
                id="routine-cron"
                value={draft.cron}
                spellCheck={false}
                className="font-mono text-sm"
                onChange={(e) => set({ cron: e.target.value })}
              />
            </div>
          )}
          {'runs' in preview ? (
            <span className="flex flex-col gap-0.5 text-xs text-fg-muted" aria-live="polite">
              <span className="font-medium text-fg-secondary">
                {describeSchedule(preview.cron, i18n.language, t)}
              </span>
              <span>
                {t('panels.bot.routine.preview', {
                  runs: preview.runs.map((r) => describeWhen(r, i18n.language, t)).join(' · '),
                })}
              </span>
            </span>
          ) : (
            <span className="text-xs text-danger" aria-live="polite">
              {t('panels.bot.routine.cronInvalid', { detail: preview.error })}
            </span>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t('panels.bot.routine.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || !valid}>
            {routine ? t('panels.bot.routine.save') : t('panels.bot.routine.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
