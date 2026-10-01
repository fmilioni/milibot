import type { Bot, Procedure, ProcedureScope } from '@milibot/shared'
import { ChevronRight, GraduationCap, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { workspaceKey } from '@/api/queries'
import { deleteProcedure, updateProcedure, useBotProcedures } from '@/features/bots/api'
import { Screenshot } from '@/features/vm/Screenshot'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import type { ClickMark } from '@/lib/click-mark'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { Spinner } from '@/ui/Spinner'
import { TextArea, TextInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

function stepMark(step: Procedure['steps'][number]): ClickMark | null {
  if (step.x === null || step.y === null) return null
  return step.kind === 'click' ||
    step.kind === 'double_click' ||
    step.kind === 'right_click' ||
    step.kind === 'middle_click'
    ? { kind: step.kind, x: step.x, y: step.y }
    : null
}

/** "Taught procedures" of the bot settings: the ones it can use (its own and the shared ones). */
export function BotProceduresSection({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const procedures = useBotProcedures(workspaceId, bot.id).data
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-secondary">{t('panels.bot.procedures.title')}</h3>
      {procedures === null ? (
        <Spinner className="text-fg-muted" />
      ) : procedures.length === 0 ? (
        <span className="text-sm text-fg-muted">{t('panels.bot.procedures.empty')}</span>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
          {procedures.map((procedure) => (
            <ProcedureItem key={procedure.id} procedure={procedure} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ProcedureItem({ procedure }: { procedure: Procedure }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const generating = procedure.status === 'generating'
  const removeMutation = useApiMutation(() => deleteProcedure(workspaceId ?? '', procedure.id), {
    invalidates: workspaceId ? [workspaceKey(workspaceId, 'procedures')] : [],
  })
  const remove = async () => {
    setDeleting(false)
    if (workspaceId) await removeMutation.run()
  }
  return (
    <li className="flex flex-col border-b border-border bg-surface-2 last:border-0">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={t('panels.bot.procedures.expand', { name: procedure.name })}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
        >
          <ChevronRight
            size={12}
            className={cn(
              'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          <GraduationCap size={13} className="shrink-0 text-accent" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-base text-fg">{procedure.name}</span>
            <span className="truncate text-xs text-fg-muted">
              {generating
                ? t('panels.bot.procedures.generating')
                : [
                    t('panels.bot.procedures.steps', { count: procedure.steps.length }),
                    procedure.scope === 'global' ? t('panels.bot.procedures.global') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </span>
        </button>
        <Tooltip content={t('panels.bot.procedures.edit')}>
          <button
            type="button"
            disabled={generating}
            onClick={() => setEditing(true)}
            aria-label={t('panels.bot.procedures.edit')}
            className="focus-ring rounded p-1 text-fg-muted hover:text-fg disabled:opacity-40"
          >
            <Pencil size={13} />
          </button>
        </Tooltip>
        <Tooltip content={t('panels.bot.procedures.delete')}>
          <button
            type="button"
            onClick={() => setDeleting(true)}
            aria-label={t('panels.bot.procedures.delete')}
            className="focus-ring rounded p-1 text-fg-muted hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3 text-sm">
          <p className="text-fg-secondary">{procedure.goal}</p>
          {procedure.error && <p className="text-warning">{t('panels.bot.procedures.error')}</p>}
          {procedure.preconditions.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-fg-muted">
                {t('panels.bot.procedures.preconditions')}
              </span>
              {procedure.preconditions.map((p) => (
                <span key={p} className="text-fg-secondary">
                  • {p}
                </span>
              ))}
            </div>
          )}
          {procedure.parameters.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-fg-muted">
                {t('panels.bot.procedures.parameters')}
              </span>
              {procedure.parameters.map((p) => (
                <span key={p.name} className="text-fg-secondary">
                  <code className="font-mono text-xs text-accent">{`{{${p.name}}}`}</code> {p.description}
                </span>
              ))}
            </div>
          )}
          <ol className="flex flex-col gap-1.5">
            {procedure.steps.map((step, i) => (
              <li key={step.id} className="flex gap-2">
                {step.screenshotSha ? (
                  <Screenshot sha={step.screenshotSha} mark={stepMark(step)} className="w-[72px]" />
                ) : (
                  <span className="w-[72px] shrink-0" />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-fg">
                    <span className="font-bold text-fg-muted">{i + 1}</span> {step.instruction}
                  </span>
                  {step.target && <span className="text-xs text-fg-muted">{step.target}</span>}
                  {step.value && <code className="font-mono text-xs text-fg-secondary">{step.value}</code>}
                  {step.narration && (
                    <span className="text-xs text-fg-secondary italic">{step.narration}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {editing && <ProcedureEditor procedure={procedure} onClose={() => setEditing(false)} />}
      {deleting && (
        <Modal
          title={t('panels.bot.procedures.delete')}
          description={t('panels.bot.procedures.deleteConfirm', { name: procedure.name })}
          width={380}
          onClose={() => setDeleting(false)}
        >
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setDeleting(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t('panels.bot.procedures.delete')}
            </Button>
          </div>
        </Modal>
      )}
    </li>
  )
}

function ProcedureEditor({ procedure, onClose }: { procedure: Procedure; onClose: () => void }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const [name, setName] = useState(procedure.name)
  const [goal, setGoal] = useState(procedure.goal)
  const [scope, setScope] = useState<ProcedureScope>(procedure.scope)
  const [steps, setSteps] = useState(
    procedure.steps.map((s) => ({ id: s.id, instruction: s.instruction, narration: s.narration ?? '' })),
  )
  const [removed, setRemoved] = useState<string[]>([])
  const saveMutation = useApiMutation(
    () =>
      updateProcedure(workspaceId ?? '', procedure.id, {
        name: name.trim(),
        goal,
        scope,
        steps: steps.map((s) => ({ id: s.id, instruction: s.instruction, narration: s.narration || null })),
        deleteStepIds: removed,
      }),
    { invalidates: workspaceId ? [workspaceKey(workspaceId, 'procedures')] : [], onSuccess: onClose },
  )
  const busy = saveMutation.busy
  const canScopeBot = procedure.taughtByBotId !== null
  const save = async () => {
    if (!workspaceId || !name.trim()) return
    await saveMutation.run()
  }
  return (
    <Modal title={procedure.name} width={560} onClose={onClose}>
      <form
        className="flex max-h-[70vh] flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-fg-secondary">
          {t('panels.bot.procedures.name')}
          <TextInput value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg-secondary">
          {t('panels.bot.procedures.goal')}
          <TextArea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <div className="flex flex-col gap-1 text-sm text-fg-secondary">
          {t('panels.bot.procedures.scope')}
          <div className="flex gap-2">
            {(['bot', 'global'] as const).map((key) => (
              <button
                key={key}
                type="button"
                disabled={key === 'bot' && !canScopeBot}
                aria-pressed={scope === key}
                onClick={() => setScope(key)}
                className={cn(
                  'focus-ring flex-1 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40',
                  scope === key
                    ? 'border-accent bg-accent-soft font-semibold text-accent'
                    : 'border-border text-fg-secondary',
                )}
              >
                {key === 'bot' ? t('panels.bot.procedures.scopeBot') : t('panels.bot.procedures.scopeGlobal')}
              </button>
            ))}
          </div>
        </div>
        <span className="text-sm text-fg-secondary">
          {t('panels.bot.procedures.steps', { count: steps.length })}
        </span>
        <ol className="scroll-slim flex min-h-0 flex-col gap-2 overflow-y-auto">
          {steps.map((step, i) => (
            <li key={step.id} className="flex items-start gap-2">
              <span className="w-4 pt-2 text-right text-xs font-bold text-fg-muted">{i + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <TextInput
                  value={step.instruction}
                  aria-label={t('panels.bot.procedures.steps', { count: i + 1 })}
                  onChange={(e) =>
                    setSteps((all) =>
                      all.map((s) => (s.id === step.id ? { ...s, instruction: e.target.value } : s)),
                    )
                  }
                />
                <TextInput
                  value={step.narration}
                  placeholder={t('panels.bot.procedures.narrationPlaceholder')}
                  aria-label={t('panels.bot.procedures.narration')}
                  className="h-[28px] text-sm"
                  onChange={(e) =>
                    setSteps((all) =>
                      all.map((s) => (s.id === step.id ? { ...s, narration: e.target.value } : s)),
                    )
                  }
                />
              </div>
              <Tooltip content={t('panels.bot.procedures.deleteStep')}>
                <button
                  type="button"
                  aria-label={t('panels.bot.procedures.deleteStep')}
                  disabled={steps.length <= 1}
                  onClick={() => {
                    setSteps((all) => all.filter((s) => s.id !== step.id))
                    setRemoved((ids) => [...ids, step.id])
                  }}
                  className="focus-ring mt-2 rounded text-fg-muted hover:text-danger disabled:opacity-40"
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ol>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t('panels.bot.procedures.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            {t('panels.bot.procedures.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
