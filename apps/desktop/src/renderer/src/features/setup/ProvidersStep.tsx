import { CLI_ENGINES, isCliEngine, type Provider } from '@milibot/shared'
import { Hourglass, Pencil, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NO_MODEL_LISTS, useProviderModelLists } from '@/features/providers/api'
import { ProviderForm } from '@/features/providers/ProviderForm'
import {
  checkedRows,
  effectiveDefault,
  type ProviderRowId,
  providerRowName,
  type ProviderStepState,
  rowOf,
} from '@/features/setup/lib/setup'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cliTextParams } from '@/lib/cli-engines'
import { cn } from '@/lib/cn'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'
import { Checkbox } from '@/ui/Checkbox'
import { Modal } from '@/ui/Modal'

import { OpenRouterKey } from './OpenRouterKey'

export type StepPatch = Partial<ProviderStepState> | ((prev: ProviderStepState) => Partial<ProviderStepState>)

function ProviderRow({
  row,
  checked,
  onToggle,
  aside,
  children,
}: {
  row: ProviderRowId
  checked: boolean
  onToggle: () => void
  aside: ReactNode
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const name = providerRowName(t, row)
  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-[10px] border px-3 py-2.5 transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2',
      )}
    >
      <div className="flex items-center gap-3">
        <Checkbox
          checked={checked}
          label={t('setup.providers.select', { name })}
          onChange={() => onToggle()}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={onToggle}
          className="flex min-w-0 flex-1 flex-col text-left"
        >
          <span className="text-base font-semibold text-fg">{name}</span>
          <span className="text-xs leading-[1.35] text-fg-secondary">
            {isCliEngine(row)
              ? t('setup.providers.cli.description', cliTextParams(row))
              : t(`setup.providers.${row === 'openrouter' ? 'openRouter' : 'compatible'}.description`)}
          </span>
        </button>
        <div className="flex shrink-0 items-center">{aside}</div>
      </div>
      {children}
    </li>
  )
}

/** "Configure" of the OpenAI-compatible row: the provider form of the settings, on top of the setup. */
function ProviderFormDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider?: Provider
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const saved = useProviderModelLists(workspaceId, provider ?? null)
  return (
    <Modal
      title={
        provider
          ? t('settings.providers.form.editTitle', { name: provider.name })
          : t('settings.providers.form.newTitle')
      }
      width={820}
      header={false}
      padded={false}
      onClose={onClose}
    >
      <AsyncView data={provider ? saved.data : NO_MODEL_LISTS} error={saved.error} onRetry={saved.reload}>
        {(models) => (
          <ProviderForm
            provider={provider}
            savedModels={models.chat}
            savedEmbeddingModels={models.embedding}
            savedImageModels={models.image}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </AsyncView>
    </Modal>
  )
}

export function ProvidersStep({
  workspaceId,
  state,
  providers,
  onChange,
  onProvidersChanged,
}: {
  workspaceId: string
  state: ProviderStepState
  providers: Provider[]
  onChange: (patch: StepPatch) => void
  onProvidersChanged: () => Promise<Provider[]>
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<{ provider?: Provider } | null>(null)
  const compatible = providers.filter((p) => rowOf(p) === 'compatible')
  const toggle = (row: ProviderRowId) => {
    if (row === 'compatible' && !state.checked.compatible && compatible.length === 0) {
      setForm({})
      return
    }
    onChange((prev) => ({ checked: { ...prev.checked, [row]: !prev.checked[row] } }))
  }
  const savedKey = providers.some((p) => rowOf(p) === 'openrouter' && p.hasSecret)
  const rows = checkedRows(state)
  const defaultRow = effectiveDefault(state)

  return (
    <div className="flex flex-col gap-2.5">
      <ul className="flex flex-col gap-2">
        {CLI_ENGINES.map((engine) => (
          <ProviderRow
            key={engine}
            row={engine}
            checked={state.checked[engine]}
            onToggle={() => toggle(engine)}
            aside={
              <span className="flex h-[25px] items-center gap-1.5 rounded-[7px] border border-border bg-surface-2 px-2 text-xs text-fg-secondary">
                <Hourglass size={11} className="text-fg-muted" />
                {t('setup.providers.cli.later')}
              </span>
            }
          />
        ))}
        <ProviderRow
          row="openrouter"
          checked={state.checked.openrouter}
          onToggle={() => toggle('openrouter')}
          aside={
            <OpenRouterKey workspaceId={workspaceId} state={state} savedKey={savedKey} onChange={onChange} />
          }
        >
          {state.checked.openrouter && ['invalid', 'unreachable'].includes(state.openRouterCheck.status) && (
            <p className="pl-7 text-xs text-danger">
              {t(`setup.providers.openRouter.${state.openRouterCheck.status as 'invalid' | 'unreachable'}`)}
            </p>
          )}
        </ProviderRow>
        <ProviderRow
          row="compatible"
          checked={state.checked.compatible}
          onToggle={() => toggle('compatible')}
          aside={
            compatible.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setForm({ provider: compatible[0] })}>
                <Pencil size={11} />
                {t('setup.providers.compatible.edit')}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setForm({})}>
                <Plus size={12} />
                {t('setup.providers.compatible.configure')}
              </Button>
            )
          }
        >
          {compatible.length > 0 && (
            <p className="truncate pl-7 text-xs text-fg-secondary">
              {compatible.map((p) => `${p.name}${p.baseUrl ? ` · ${p.baseUrl}` : ''}`).join(', ')}
            </p>
          )}
        </ProviderRow>
      </ul>
      {rows.length > 0 && (
        <div
          role="radiogroup"
          aria-label={t('setup.providers.defaultLabel')}
          className="flex flex-wrap items-center gap-x-3.5 gap-y-1"
        >
          <span className="text-sm text-fg-secondary">{t('setup.providers.defaultLabel')}</span>
          {rows.map((row) => (
            <label key={row} className="flex items-center gap-1.5 text-sm text-fg">
              <input
                type="radio"
                name="setup-default-provider"
                className="peer sr-only"
                checked={defaultRow === row}
                onChange={() => onChange({ defaultRow: row })}
              />
              <span
                aria-hidden
                className={cn(
                  'size-3.5 shrink-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                  defaultRow === row ? 'border-4 border-accent' : 'border border-fg-muted',
                )}
              />
              {providerRowName(t, row)}
            </label>
          ))}
        </div>
      )}
      {form && (
        <ProviderFormDialog
          provider={form.provider}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            void onProvidersChanged().then((list) => {
              const ids = list.filter((p) => rowOf(p) === 'compatible').map((p) => p.id)
              onChange((prev) => ({
                compatibleIds: ids,
                checked: { ...prev.checked, compatible: ids.length > 0 },
              }))
            })
          }}
        />
      )}
    </div>
  )
}
