import type { WorkSessionDetail } from '@milibot/shared'
import { ClipboardList } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PlanDialog } from '@/features/plans/PlanDialog'
import { PlanProgress, PlanStepList } from '@/features/plans/PlanParts'
import { isSessionFinished } from '@/features/sessions/lib/session-view'
import { Markdown } from '@/ui/Markdown'

/** "Plan": the steps the session follows (its plan's, or its own list) and, once finished, the result. */
export function PlanPane({ session }: { session: WorkSessionDetail }) {
  const { t } = useTranslation()
  const [planOpen, setPlanOpen] = useState(false)
  const finished = isSessionFinished(session.status)
  const markdown = { copyLabel: t('chat.copyCode'), copiedLabel: t('chat.copied') }

  return (
    <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
      {finished && session.resultSummary && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
            {t('session.plan.result')}
          </h3>
          <div className="rounded-lg border border-border bg-surface-2 px-3.5 py-1">
            <Markdown text={session.resultSummary} compact {...markdown} />
          </div>
        </section>
      )}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
            {session.planId ? t('session.plan.planSteps') : t('session.plan.steps')}
          </h3>
          <span className="flex-1" />
          {session.planId && (
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="focus-ring flex items-center gap-1 rounded text-sm text-accent hover:underline"
            >
              <ClipboardList size={13} aria-hidden />
              {t('plans.card.view')}
            </button>
          )}
        </div>
        {session.todos.length > 0 ? (
          <>
            <PlanProgress {...session.steps} />
            <PlanStepList steps={session.todos} />
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            {finished ? t('session.plan.noSteps') : t('session.plan.noStepsYet')}
          </p>
        )}
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
          {t('session.plan.goal')}
        </h3>
        <p className="selectable text-base leading-[1.5] whitespace-pre-wrap text-fg-secondary">
          {session.goal}
        </p>
      </section>
      {planOpen && session.planId && (
        <PlanDialog planId={session.planId} onClose={() => setPlanOpen(false)} />
      )}
    </div>
  )
}
