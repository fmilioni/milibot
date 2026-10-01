import { CLI_ENGINE_INFO, type CliAuthMode, type CliEngine, firstBot, type Provider } from '@milibot/shared'
import { CircleCheck, CircleDashed, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { checkProvider, openCliLoginTerminal, updateProvider } from '@/features/providers/api'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cliTextParams } from '@/lib/cli-engines'
import { apiErrorReason, errorMessage } from '@/lib/errors'
import { Button } from '@/ui/Button'
import { Segmented } from '@/ui/Segmented'
import { Tag } from '@/ui/Tag'

import { CliInstallLine } from './CliInstallLine'
import { ProviderMenu } from './ProviderMenu'

export function CliProviderCard({
  provider,
  engine,
  onChanged,
}: {
  provider: Provider
  engine: CliEngine
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const info = CLI_ENGINE_INFO[engine]
  const params = cliTextParams(engine)
  const workspaceId = useWorkspaceId()
  const usage = useAppStore((s) => s.cliUsage[provider.id])
  const vmState = useAppStore((s) => s.vm?.state)
  const bots = useAppStore((s) => s.bots)
  const [mode, setMode] = useState<CliAuthMode>(provider.authMode ?? 'subscription')
  const [secret, setSecret] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [checking, setChecking] = useState<'idle' | 'checking' | 'ok' | 'failed'>('idle')
  const [checkError, setCheckError] = useState<string | null>(null)
  const first = firstBot(Object.values(bots))

  const [savedMode, setSavedMode] = useState(provider.authMode)
  if (savedMode !== provider.authMode) {
    setSavedMode(provider.authMode)
    setMode(provider.authMode ?? 'subscription')
  }

  const saveMutation = useApiMutation(
    (patch: { authMode?: CliAuthMode; apiKey?: string; baseUrl?: string | null }) =>
      updateProvider(workspaceId, provider.id, patch),
    {
      invalidates: [queryKeys.providers(workspaceId)],
      onSuccess: () => {
        setSecret('')
        onChanged()
      },
    },
  )
  const save = saveMutation.run

  const terminal = useApiMutation(() => openCliLoginTerminal(workspaceId, engine, first?.id ?? null), {
    // Conflicts of this route: the VM is off (the daemon is already starting it), or the CLI failed to install.
    errorToast: (err) => (apiErrorReason(err) === 'vm_not_running' ? 'vmStarting' : 'error'),
    onSuccess: ({ botId }) => {
      const store = useAppStore.getState()
      const dm = Object.values(store.conversations).find(
        (c) => c.type === 'direct' && c.memberBotIds.includes(botId),
      )
      store.closeSettings()
      if (dm) store.selectConversation(dm.id)
      store.showBotScreen(botId)
      void store.controlBot(botId, 'takeover').catch(() => undefined)
    },
  })

  const check = async () => {
    setChecking('checking')
    setCheckError(null)
    try {
      const result = await checkProvider(workspaceId, provider.id)
      setChecking(result.ok ? 'ok' : 'failed')
      setCheckError(result.error)
    } catch (err) {
      setChecking('failed')
      setCheckError(errorMessage(err))
    }
  }

  const authModeLabel = (value: CliAuthMode) =>
    value === 'subscription'
      ? t('settings.providers.cli.subscription', params)
      : value === 'api_key'
        ? t('settings.providers.cli.apiKey')
        : t('settings.providers.cli.gateway')

  const connected =
    checking === 'ok' || (checking === 'idle' && Boolean(usage?.plan) && mode === 'subscription')
  const plan = usage?.plan && usage.plan !== 'api' ? usage.plan : null

  return (
    <li className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-md font-semibold text-fg">{provider.name}</span>
        <Tag>{t('settings.providers.inVm')}</Tag>
        {provider.isDefault && <Tag tone="success">{t('settings.providers.default')}</Tag>}
        <span className="ml-auto" />
        <ProviderMenu provider={provider} onChanged={onChanged} />
      </div>
      {info.needsInstall && <CliInstallLine engine={engine} vmRunning={vmState === 'running'} />}
      {info.authModes.length > 1 && (
        <div className="w-fit">
          <Segmented
            label={t('settings.providers.cli.auth', params)}
            value={mode}
            options={info.authModes.map((value) => ({ value, label: authModeLabel(value) }))}
            onChange={(next) => {
              setMode(next)
              if (next === 'subscription') void save({ authMode: next })
            }}
          />
        </div>
      )}
      {mode === 'subscription' ? (
        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <CircleCheck size={15} className="text-success" aria-hidden />
          ) : (
            <CircleDashed size={15} className="text-fg-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 text-base text-fg-secondary">
            {connected
              ? plan
                ? t('settings.providers.cli.connectedPlan', { ...params, plan: plan.toUpperCase() })
                : t('settings.providers.cli.connected', params)
              : checking === 'failed'
                ? t('settings.providers.cli.notLoggedIn', params)
                : t('settings.providers.cli.loginHint', params)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={checking === 'checking' || vmState !== 'running'}
            onClick={() => void check()}
          >
            {checking === 'checking'
              ? t('settings.providers.cli.checking')
              : t('settings.providers.cli.check')}
          </Button>
          <Button size="sm" disabled={terminal.busy} onClick={() => void terminal.run()}>
            <SquareTerminal size={13} />
            {t('settings.providers.cli.openTerminal')}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save({
              authMode: mode,
              ...(secret.trim() ? { apiKey: secret.trim() } : {}),
              ...(mode === 'auth_token' ? { baseUrl: baseUrl.trim() || null } : { baseUrl: null }),
            })
          }}
        >
          {mode === 'auth_token' && (
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-fg-secondary">
                {t('settings.providers.cli.baseUrl')}
              </span>
              <input
                className={`${COMPACT_INPUT} font-mono`}
                value={baseUrl}
                placeholder="https://gateway.example.com"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
          )}
          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-fg-secondary">
              {mode === 'api_key'
                ? t('settings.providers.cli.keyLabel', params)
                : t('settings.providers.cli.tokenLabel')}
            </span>
            <input
              className={`${COMPACT_INPUT} font-mono`}
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={
                provider.hasSecret && provider.authMode === mode
                  ? t('settings.providers.form.keySaved')
                  : mode === 'api_key'
                    ? info.keyPlaceholder
                    : ''
              }
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <Button size="sm" variant="primary" type="submit">
            {t('common.save')}
          </Button>
        </form>
      )}
      {checkError && checking === 'failed' && <p className="selectable text-sm text-danger">{checkError}</p>}
      <p className="text-xs leading-[15px] text-fg-muted">{t(`settings.providers.cli.${engine}.note`)}</p>
    </li>
  )
}
