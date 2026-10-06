import { planProgress } from '@milibot/shared'
import { ClipboardList, FileDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { planActions, planMarkdown, revisionDiff } from '@/features/plans/lib/plans'
import { useProjectStore } from '@/features/projects/store'
import { useAppStore } from '@/features/workspace/store'
import { useAsyncAction } from '@/features/workspace/use-async-action'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatDay } from '@/lib/format'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'
import { InlineConfirm } from '@/ui/Confirm'
import { DiffStat } from '@/ui/diff/DiffStat'
import { DiffView } from '@/ui/diff/DiffView'
import { LinkifiedText } from '@/ui/LinkifiedText'
import { Markdown } from '@/ui/Markdown'
import { Modal } from '@/ui/Modal'

import { PlanDecision } from './PlanDecision'
import { PlanProgress, PlanStatusChip, PlanStepList } from './PlanParts'
import { usePlanStore } from './store'

/** "View plan": the plan's text, steps and revisions, with the actions its status allows. */
export function PlanDialog({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const showToast = useAppStore((s) => s.showToast)
  const projects = useProjectStore((s) => s.projects)
  const detail = usePlanStore((s) => s.detail)
  const setStatus = usePlanStore((s) => s.setStatus)
  const remove = usePlanStore((s) => s.remove)
  const {
    data: plan,
    error,
    reload,
  } = useApiQuery(queryKeys.plan(workspaceId, planId), () => detail(workspaceId, planId))
  const [shown, setShown] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [runAction, busy] = useAsyncAction()

  const run = (action: () => Promise<void>, close = false) =>
    void runAction(async () => {
      await action()
      if (close) onClose()
    })

  if (!plan) {
    return (
      <Modal title={t('plans.dialog.title')} width={720} onClose={onClose}>
        <AsyncView data={plan} error={error} errorText={t('plans.dialog.loadFailed')} onRetry={reload}>
          {() => null}
        </AsyncView>
      </Modal>
    )
  }

  const author = bots[plan.botId]
  const project = plan.projectId ? projects.find((p) => p.id === plan.projectId) : null
  const actions = planActions(plan.status)
  const latest = plan.revisions.at(-1)?.revision ?? null
  const viewing = shown !== null && shown !== latest ? plan.revisions.find((r) => r.revision === shown) : null
  const diff = shown !== null ? revisionDiff(plan.revisions, shown) : null

  const save = () => {
    const shownPlan = viewing ?? plan
    const text = planMarkdown(shownPlan, { steps: t('plans.dialog.steps') })
    window.milibot
      .saveMarkdownFile(text, { defaultName: shownPlan.title, title: t('plans.dialog.saveTitle') })
      .then((saved) => saved && showToast('planSaved'))
      .catch(() => showToast('error'))
  }

  return (
    <Modal title={plan.title} width={760} onClose={onClose} icon={<ClipboardList size={17} />}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-fg-muted">
        <PlanStatusChip status={plan.status} />
        {author && <span>{t('plans.dialog.byBot', { name: author.name })}</span>}
        <span>{t('plans.dialog.project', { name: project?.name ?? t('plans.general') })}</span>
        <span>{formatDay(plan.createdAt, i18n.language, t)}</span>
        {plan.revision > 1 && <span>{t('plans.revision', { n: plan.revision })}</span>}
      </div>
      {plan.feedback && (
        <p className="rounded-lg bg-surface px-3 py-2 text-sm text-fg-secondary">
          {t(plan.status === 'rejected' ? 'plans.card.rejectedWith' : 'plans.card.changesRequested', {
            comment: plan.feedback,
          })}
        </p>
      )}
      {plan.revisions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-fg-secondary">{t('plans.dialog.revisions')}</span>
          {plan.revisions.map((r) => {
            const active = (shown ?? latest) === r.revision
            return (
              <button
                key={r.revision}
                type="button"
                aria-pressed={active}
                onClick={() => setShown(r.revision)}
                className={cn(
                  'focus-ring rounded-md px-2 py-0.5 text-sm',
                  active
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-fg-secondary hover:bg-surface-3',
                )}
              >
                {t('plans.revision', { n: r.revision })}
              </button>
            )
          })}
        </div>
      )}
      {diff && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-fg-secondary">{t('plans.dialog.changes')}</span>
            <DiffStat added={diff.added} removed={diff.removed} strong />
          </div>
          <DiffView diff={diff.diff} />
        </div>
      )}
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-fg-secondary">{t('plans.dialog.summary')}</h3>
        <p className="text-base leading-[1.5] text-fg">
          <LinkifiedText text={viewing?.summary ?? plan.summary} />
        </p>
      </section>
      <section className="rounded-xl border border-border bg-surface px-4 py-1">
        <Markdown text={viewing?.body ?? plan.body} compact />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg-secondary">{t('plans.dialog.steps')}</h3>
        {viewing ? (
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-base text-fg">
            {viewing.steps.map((s, i) => (
              <li key={i}>{s.title}</li>
            ))}
          </ol>
        ) : (
          <>
            {plan.status !== 'draft' && plan.status !== 'awaiting_approval' && (
              <PlanProgress {...planProgress(plan.steps)} />
            )}
            <PlanStepList steps={plan.steps} />
          </>
        )}
      </section>
      {actions.decide && (
        <PlanDecision planId={plan.id} execution={plan.execution} model={plan.model} onDecided={onClose} />
      )}
      {confirmDelete ? (
        <InlineConfirm
          message={t('plans.dialog.deleteQuestion')}
          confirmLabel={t('plans.dialog.deleteConfirm')}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => run(() => remove(workspaceId, plan.id), true)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <Button
            size="sm"
            variant="danger-outline"
            className="mr-auto"
            onClick={() => setConfirmDelete(true)}
          >
            {t('plans.dialog.delete')}
          </Button>
          <Button size="sm" variant="outline" onClick={save}>
            <FileDown size={14} />
            {t('plans.dialog.save')}
          </Button>
          {actions.finish && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(() => setStatus(workspaceId, plan.id, 'cancelled'))}
              >
                {t('plans.dialog.cancelPlan')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => run(() => setStatus(workspaceId, plan.id, 'done'))}
              >
                {t('plans.dialog.markDone')}
              </Button>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
