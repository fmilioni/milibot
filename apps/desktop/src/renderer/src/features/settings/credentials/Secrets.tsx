import { ENV_SECRET_NAME_PATTERN, type EnvSecret, type EnvSecretScope } from '@milibot/shared'
import { DollarSign, EyeOff, Lock, Pencil, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { createEnvSecret, deleteEnvSecret, updateEnvSecret } from '@/features/settings/api'
import { COMPACT_INPUT, ErrorLine } from '@/features/settings/SettingsLayout'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { errorMessage, isApiError } from '@/lib/errors'
import { botNames, botOptions } from '@/lib/select-options'
import { Button } from '@/ui/Button'
import type { MenuEntry } from '@/ui/Menu'
import { MoreMenu } from '@/ui/MoreMenu'
import { MultiSelect } from '@/ui/MultiSelect'
import { Switch } from '@/ui/Switch'
import { FieldLabel } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

/** Adds a password/variable, or edits one (an empty value keeps the saved one). */
export function SecretForm({
  secret,
  onClose,
  onSaved,
}: {
  secret?: EnvSecret
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const [name, setName] = useState(secret?.name ?? '')
  const [label, setLabel] = useState(secret?.label ?? '')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<EnvSecretScope>(secret?.scope ?? 'all')
  const [exposeAsEnv, setExposeAsEnv] = useState(secret?.exposeAsEnv ?? true)
  const [error, setError] = useState<unknown>(null)
  const id = useId()
  const validName = ENV_SECRET_NAME_PATTERN.test(name)
  const canSave = validName && (secret ? true : value.length > 0)
  const saveSecret = useApiMutation(
    () => {
      const fields = { name, scope, exposeAsEnv, label: label.trim() || null }
      return secret
        ? updateEnvSecret(workspaceId, secret.id, { ...fields, ...(value ? { value } : {}) })
        : createEnvSecret(workspaceId, { ...fields, value })
    },
    { invalidates: [queryKeys.credentials(workspaceId, 'secrets')], errorToast: false },
  )
  const save = async () => {
    setError(null)
    try {
      await saveSecret.run()
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-accent bg-surface-2 p-3.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) void save()
      }}
    >
      <div className="flex flex-wrap gap-3">
        <div className="flex w-[200px] flex-col gap-[5px]">
          <FieldLabel htmlFor={`${id}-name`}>{t('settings.credentials.secrets.fieldName')}</FieldLabel>
          <input
            id={`${id}-name`}
            placeholder="STRIPE_API_KEY"
            autoFocus
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            className={cn(COMPACT_INPUT, 'font-mono', name && !validName && 'border-danger-soft')}
          />
        </div>
        <div className="flex min-w-[160px] flex-1 flex-col gap-[5px]">
          <FieldLabel htmlFor={`${id}-label`}>{t('settings.credentials.secrets.fieldLabel')}</FieldLabel>
          <input
            id={`${id}-label`}
            placeholder={t('settings.credentials.secrets.labelPlaceholder')}
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
            className={COMPACT_INPUT}
          />
        </div>
        <div className="flex w-[260px] flex-col gap-[5px]">
          <FieldLabel htmlFor={`${id}-value`}>{t('settings.credentials.secrets.fieldValue')}</FieldLabel>
          <input
            id={`${id}-value`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={
              secret ? t('settings.credentials.secrets.keepValue') : t('settings.credentials.secrets.value')
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`${COMPACT_INPUT} font-mono placeholder:font-sans`}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-secondary">{t('settings.credentials.secrets.scope')}</span>
        <div className="w-[260px]">
          <MultiSelect
            label={t('settings.credentials.secrets.scope')}
            allLabel={t('settings.credentials.secrets.all')}
            placeholder={t('settings.credentials.secrets.pickBots')}
            options={botOptions(bots)}
            value={scope === 'all' ? 'all' : scope}
            onChange={(next) => setScope(next === 'all' || next.length === 0 ? 'all' : next)}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-base font-semibold text-fg">
            {t('settings.credentials.secrets.exposeAsEnv')}
          </span>
          <span className="text-xs leading-[15px] text-fg-secondary">
            {exposeAsEnv
              ? t('settings.credentials.secrets.exposeAsEnvOn')
              : t('settings.credentials.secrets.exposeAsEnvOff')}
          </span>
        </div>
        <Switch
          checked={exposeAsEnv}
          label={t('settings.credentials.secrets.exposeAsEnv')}
          onChange={setExposeAsEnv}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!canSave}>
          {t('common.save')}
        </Button>
      </div>
      {error !== null && (
        <ErrorLine
          message={
            isApiError(error, 'conflict')
              ? t('settings.credentials.secrets.nameTaken', { name })
              : t('settings.credentials.secrets.saveFailed')
          }
          detail={errorMessage(error)}
        />
      )}
    </form>
  )
}

export function SecretRow({
  secret,
  editing,
  onEdit,
}: {
  secret: EnvSecret
  editing: boolean
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const remove = useApiMutation(() => deleteEnvSecret(workspaceId, secret.id), {
    invalidates: [queryKeys.credentials(workspaceId, 'secrets')],
  })
  const scopeLabel =
    secret.scope === 'all' ? t('settings.credentials.secrets.all') : botNames(secret.scope, bots)
  const entries: MenuEntry[] = [
    {
      key: 'edit',
      label: t('settings.credentials.secrets.edit'),
      icon: <Pencil size={14} />,
      onSelect: onEdit,
    },
    { type: 'separator', key: 'sep' },
    {
      key: 'delete',
      label: t('settings.credentials.secrets.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => void remove.run(),
    },
  ]
  return (
    <li
      className={cn(
        'flex h-[34px] items-center gap-3 rounded-[9px] border bg-surface px-3',
        editing ? 'border-accent' : 'border-border',
      )}
    >
      <Lock size={12} className="shrink-0 text-fg-muted" aria-hidden />
      <span className="selectable shrink-0 font-mono text-sm font-semibold text-fg">{secret.name}</span>
      {!secret.exposeAsEnv && secret.label ? (
        <span className="selectable min-w-0 flex-1 truncate text-sm text-fg-secondary">{secret.label}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-muted">{secret.preview}</span>
      )}
      <Tooltip
        content={
          secret.exposeAsEnv
            ? t('settings.credentials.secrets.kindEnvHint', { name: secret.name })
            : t('settings.credentials.secrets.kindRefHint')
        }
      >
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-px text-xs',
            secret.exposeAsEnv ? 'bg-accent-soft text-accent' : 'bg-success-soft text-success',
          )}
        >
          {secret.exposeAsEnv ? <DollarSign size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
          {secret.exposeAsEnv
            ? t('settings.credentials.secrets.kindEnv')
            : t('settings.credentials.secrets.kindRef')}
        </span>
      </Tooltip>
      <span className="max-w-[40%] shrink-0 truncate rounded-md bg-surface-3 px-1.5 py-0.5 text-xs text-fg-secondary">
        {scopeLabel}
      </span>
      <MoreMenu
        label={t('settings.credentials.secrets.more', { name: secret.name })}
        entries={entries}
        width={180}
        menuLabel={secret.name}
      />
    </li>
  )
}
