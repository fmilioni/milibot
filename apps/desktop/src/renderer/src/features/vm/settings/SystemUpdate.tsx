import type { VmDetails } from '@milibot/shared'
import { CircleArrowUp, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice } from '@/features/settings/SettingsLayout'
import { etaText } from '@/features/setup/lib/setup'
import { useSetupStore } from '@/features/setup/store'
import { goldenWait, newRevisions, type SystemUpdatePhase } from '@/features/vm/lib/system-update'
import { useAppStore } from '@/features/workspace/store'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

/** "What's new" lines of each revision newer than the VM's (a revision without text adds nothing). */
export function useRevisionTexts(details: VmDetails) {
  const { t, i18n } = useTranslation()
  const revisions = newRevisions(details.vm)
  const changes = revisions.flatMap((r) => {
    const key = `settings.vm.update.changes.${r}`
    return i18n.exists(key)
      ? (t(key as 'settings.vm.update.changes.2', { returnObjects: true }) as string[])
      : []
  })
  const summaryKey = `settings.vm.update.summary.${revisions.at(-1) ?? 0}`
  const summary = i18n.exists(summaryKey) ? t(summaryKey as 'settings.vm.update.summary.2') : null
  return { changes, summary }
}

export /** Progress of a system update that waits (new golden image, idle bots, another operation) or runs. */
function SystemUpdateProgress({ status, onCancel }: { status: SystemUpdatePhase; onCancel: () => void }) {
  const { t } = useTranslation()
  const golden = useSetupStore((s) => s.golden)
  const loadGolden = useSetupStore((s) => s.loadGolden)
  const buildGolden = useSetupStore((s) => s.buildGolden)
  const showToast = useAppStore((s) => s.showToast)
  useEffect(() => {
    if (status === 'waiting_golden') void loadGolden().catch(() => undefined)
  }, [loadGolden, status])

  const cancel = (
    <Button size="sm" onClick={onCancel}>
      {t('common.cancel')}
    </Button>
  )
  const spinner = <Spinner size={14} />
  if (status === 'waiting_idle' || status === 'waiting_task') {
    return (
      <Notice tone="accent" icon={spinner} action={cancel}>
        {status === 'waiting_idle'
          ? t('settings.vm.update.waitingIdle')
          : t('settings.vm.update.waitingTask')}
      </Notice>
    )
  }
  if (status !== 'waiting_golden') {
    return (
      <Notice tone="accent" icon={spinner}>
        {t('settings.vm.tasks.update_system')}
      </Notice>
    )
  }
  const wait = goldenWait(golden)
  if (wait.state === 'failed') {
    return (
      <Notice
        tone="danger"
        icon={<TriangleAlert size={14} className="text-danger" />}
        action={
          <div className="flex shrink-0 gap-2">
            {cancel}
            <Button
              size="sm"
              variant="primary"
              onClick={() => void buildGolden().catch(() => showToast('error'))}
            >
              {t('common.retry')}
            </Button>
          </div>
        }
      >
        {t('settings.vm.update.failed', { error: wait.error })}
      </Notice>
    )
  }
  let text = t('settings.vm.update.preparing')
  if (wait.state === 'building') {
    const percent = Math.round(wait.percent)
    text =
      wait.etaSeconds === null
        ? t('settings.vm.update.preparingProgress', { percent })
        : t('settings.vm.update.preparingEta', {
            percent,
            eta: etaText(wait.etaSeconds, t),
          })
  }
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-accent-soft px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="shrink-0 text-accent" aria-hidden>
          {spinner}
        </span>
        <span className="min-w-0 flex-1 text-sm leading-[17px] text-fg">{text}</span>
        {cancel}
      </div>
      {wait.state === 'building' && (
        <div
          className="h-1 overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label={t('settings.vm.update.preparing')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(wait.percent)}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${wait.percent}%` }}
          />
        </div>
      )}
    </div>
  )
}

export function SystemUpdateNotice({ details, onUpdate }: { details: VmDetails; onUpdate: () => void }) {
  const { t } = useTranslation()
  const { summary } = useRevisionTexts(details)
  return (
    <Notice
      tone="accent"
      icon={<CircleArrowUp size={14} className="text-accent" />}
      action={
        <Button size="sm" variant="primary" className="shrink-0" onClick={onUpdate}>
          {t('settings.vm.update.button')}
        </Button>
      }
    >
      {summary ? t('settings.vm.update.notice', { summary }) : t('settings.vm.update.noticeGeneric')}
    </Notice>
  )
}
