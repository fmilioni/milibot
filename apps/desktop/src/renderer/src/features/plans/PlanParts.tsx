import type { PlanStatus, PlanStep } from '@milibot/shared'
import { Check, Circle, CircleDot, CircleSlash } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { planTone } from '@/features/plans/lib/plans'
import { cn } from '@/lib/cn'
import { LinkifiedText } from '@/ui/LinkifiedText'
import { StatusChip } from '@/ui/Tag'

export function PlanStatusChip({ status }: { status: PlanStatus }) {
  const { t } = useTranslation()
  return <StatusChip tone={planTone(status)}>{t(`plans.status.${status}`)}</StatusChip>
}

export function PlanProgress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation()
  if (total === 0) return null
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <div
          className="h-full rounded-full bg-success transition-[width] motion-reduce:transition-none"
          style={{ width: `${Math.round((done / total) * 100)}%` }}
        />
      </div>
      <span className="shrink-0 text-xs text-fg-muted tabular-nums">{t('plans.steps', { done, total })}</span>
    </div>
  )
}

const STEP_ICONS = { pending: Circle, in_progress: CircleDot, done: Check, skipped: CircleSlash }

export function PlanStepList({ steps }: { steps: PlanStep[] }) {
  const { t } = useTranslation()
  if (!steps.length) return <p className="text-sm text-fg-muted">{t('plans.dialog.noSteps')}</p>
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step) => {
        const Icon = STEP_ICONS[step.status]
        return (
          <li key={step.id} className="flex items-start gap-2 text-base">
            <Icon
              size={14}
              aria-label={t(`plans.stepStatus.${step.status}`)}
              className={cn(
                'mt-0.5 shrink-0',
                step.status === 'done'
                  ? 'text-success'
                  : step.status === 'in_progress'
                    ? 'text-accent'
                    : 'text-fg-muted',
              )}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span
                className={
                  step.status === 'skipped'
                    ? 'text-fg-muted line-through'
                    : step.status === 'in_progress'
                      ? 'font-semibold text-fg'
                      : 'text-fg'
                }
              >
                <LinkifiedText text={step.title} />
              </span>
              {step.detail && (
                <span className="text-sm text-fg-secondary">
                  <LinkifiedText text={step.detail} />
                </span>
              )}
              {step.note && (
                <span className="text-sm text-fg-muted italic">
                  <LinkifiedText text={step.note} />
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
