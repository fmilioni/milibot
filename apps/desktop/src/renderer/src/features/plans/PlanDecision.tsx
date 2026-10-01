import type { ModelChoice, PlanExecution, ReasoningEffort } from '@milibot/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { effortForModel, effortOptions, MODEL_DEFAULT } from '@/features/providers/lib/models'
import { decodeModelChoice, encodeModelChoice } from '@/features/providers/lib/provider-form'
import { findCatalogModel, useModelCatalog } from '@/features/providers/use-model-catalog'
import { useWorkspacePreferences } from '@/features/settings/store'
import { useAsyncAction } from '@/features/workspace/use-async-action'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Button } from '@/ui/Button'
import { Select } from '@/ui/Select'
import { Switch } from '@/ui/Switch'
import { TextArea } from '@/ui/TextInput'

import { usePlanStore } from './store'

type Mode = 'idle' | 'changes' | 'reject'

/** Approve / ask for changes (with a comment) / reject a plan waiting for the user. */
export function PlanDecision({
  planId,
  execution,
  model = null,
  onDecided,
  onView,
}: {
  planId: string
  /** Where the bot proposed to run it; the user can switch before approving. */
  execution: PlanExecution
  /** Model the bot asked for its session (null: the bot's own); the user can switch it too. */
  model?: ModelChoice | null
  onDecided?: () => void
  /** Shows "View plan" next to the actions (the chat card). */
  onView?: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const approve = usePlanStore((s) => s.approve)
  const requestChanges = usePlanStore((s) => s.requestChanges)
  const reject = usePlanStore((s) => s.reject)
  const [mode, setMode] = useState<Mode>('idle')
  const [comment, setComment] = useState('')
  const [runAction, busy] = useAsyncAction()
  const [inSession, setInSession] = useState(execution === 'session')
  const { prefs } = useWorkspacePreferences(workspaceId)
  const [mergePr, setMergePr] = useState<boolean | null>(null)
  const merge = mergePr ?? prefs.autoMergePrs
  const [sessionModel, setSessionModel] = useState<ModelChoice | null>(model)

  const run = (action: () => Promise<void>) =>
    void runAction(async () => {
      await action()
      setMode('idle')
      setComment('')
      onDecided?.()
    })

  if (mode !== 'idle') {
    const changes = mode === 'changes'
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (changes && !comment.trim()) return
          run(() =>
            changes
              ? requestChanges(workspaceId, planId, comment.trim())
              : reject(workspaceId, planId, comment),
          )
        }}
      >
        <TextArea
          data-autofocus
          autoFocus
          rows={3}
          maxLength={4000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t(changes ? 'plans.card.changesPlaceholder' : 'plans.card.rejectPlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setMode('idle')
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setMode('idle')}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            type="submit"
            variant={changes ? 'primary' : 'danger'}
            disabled={busy || (changes && !comment.trim())}
          >
            {t(changes ? 'plans.card.sendChanges' : 'plans.card.rejectConfirm')}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      <label className="flex w-fit cursor-pointer items-start gap-2 text-sm">
        <Switch checked={inSession} onChange={setInSession} label={t('plans.card.inSession')} />
        <span className="flex flex-col gap-0.5">
          <span className="text-fg-secondary">{t('plans.card.inSession')}</span>
          <span className="text-fg-muted">{t('plans.card.inSessionHint')}</span>
        </span>
      </label>
      {inSession && (
        <label className="flex w-fit cursor-pointer items-start gap-2 text-sm">
          <Switch checked={merge} onChange={setMergePr} label={t('plans.card.mergePr')} />
          <span className="flex flex-col gap-0.5">
            <span className="text-fg-secondary">{t('plans.card.mergePr')}</span>
            <span className="text-fg-muted">{t('plans.card.mergePrHint')}</span>
          </span>
        </label>
      )}
      {inSession && <SessionModelPicker model={model} value={sessionModel} onChange={setSessionModel} />}
      <div className="flex flex-wrap items-center gap-2">
        {onView && (
          <Button size="sm" variant="ghost" onClick={onView} className="mr-auto">
            {t('plans.card.view')}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('reject')}>
          {t('plans.card.reject')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('changes')}>
          {t('plans.card.requestChanges')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() =>
            run(() =>
              approve(
                workspaceId,
                planId,
                inSession ? 'session' : 'chat',
                inSession && mergePr !== null ? mergePr : undefined,
                inSession ? sessionModel : undefined,
              ),
            )
          }
        >
          {t('plans.card.approve')}
        </Button>
      </div>
    </div>
  )
}

/** Model and effort of the plan's session: the bot's own model, or any provider's model. */
function SessionModelPicker({
  model,
  value,
  onChange,
}: {
  model: ModelChoice | null
  value: ModelChoice | null
  onChange: (value: ModelChoice | null) => void
}) {
  const { t } = useTranslation()
  const catalog = useModelCatalog()
  const current = findCatalogModel(catalog, value)
  const efforts = value ? effortOptions(t, current) : []
  const options = [
    { value: '', label: t('plans.card.botModel') },
    ...catalog.map((m) => ({
      value: encodeModelChoice({ providerId: m.providerId, model: m.id }),
      label: `${m.providerName} · ${m.displayName}`,
      group: m.providerName,
    })),
  ]
  const encoded = value ? encodeModelChoice({ providerId: value.providerId, model: value.model }) : ''
  if (encoded && !options.some((o) => o.value === encoded))
    options.push({ value: encoded, label: value?.model ?? '', group: '' })
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-fg-secondary">{t('plans.card.sessionModel')}</span>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            size="sm"
            label={t('plans.card.sessionModel')}
            value={encoded}
            options={options}
            onChange={(next) => {
              const choice = decodeModelChoice(next)
              onChange(
                choice && {
                  ...choice,
                  effort: effortForModel(value?.effort ?? null, findCatalogModel(catalog, choice)),
                },
              )
            }}
          />
        </div>
        <div className="w-[110px] shrink-0">
          <Select
            size="sm"
            label={t('plans.card.effort')}
            disabled={!efforts.length}
            value={efforts.length ? (value?.effort ?? MODEL_DEFAULT) : MODEL_DEFAULT}
            options={efforts.length ? efforts : [{ value: MODEL_DEFAULT, label: t('plans.card.effort') }]}
            menuWidth={200}
            menuAlign="end"
            onChange={(effort) =>
              value &&
              onChange({ ...value, effort: effort === MODEL_DEFAULT ? null : (effort as ReasoningEffort) })
            }
          />
        </div>
      </div>
      {model && <span className="text-fg-muted">{t('plans.card.sessionModelHint')}</span>}
    </div>
  )
}
