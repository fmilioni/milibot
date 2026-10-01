import type { WebSearchProvider, WebSearchStatus } from '@milibot/shared'
import { Plus, RefreshCw, Search, Unplug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { deleteWebSearchKey, setWebSearchKey } from '@/features/settings/api'
import { ErrorLine, SettingsRow } from '@/features/settings/SettingsLayout'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { errorMessage, isApiError } from '@/lib/errors'
import { Button } from '@/ui/Button'
import { Segmented } from '@/ui/Segmented'
import { Spinner } from '@/ui/Spinner'
import { TextInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

const SIGN_UP: Record<WebSearchProvider, string> = {
  brave: 'https://api-dashboard.search.brave.com/',
  tavily: 'https://app.tavily.com/',
}

const PLACEHOLDER: Record<WebSearchProvider, string> = { brave: 'BSA…', tavily: 'tvly-…' }

/** The search API key bots use for web_search (without one they search in their browser). */
export function WebSearchKey({ status }: { status: WebSearchStatus | null }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const [editing, setEditing] = useState(false)
  const [provider, setProvider] = useState<WebSearchProvider>(status?.provider ?? 'brave')
  const [key, setKey] = useState('')
  const [error, setError] = useState<unknown>(null)
  const connected = !!status?.provider
  const invalidates = [queryKeys.credentials(workspaceId, 'web-search')]
  const saveKey = useApiMutation(
    (body: { provider: WebSearchProvider; key: string }) => setWebSearchKey(workspaceId, body),
    { invalidates, errorToast: false },
  )
  const busy = saveKey.busy
  const removeKey = useApiMutation(() => deleteWebSearchKey(workspaceId), { invalidates })

  const save = async () => {
    setError(null)
    try {
      await saveKey.run({ provider, key: key.trim() })
      setEditing(false)
      setKey('')
    } catch (err) {
      setError(err)
    }
  }

  const remove = () => void removeKey.run()

  const hint = status?.provider
    ? [status.keyPreview, status.lastError && t('settings.credentials.webSearch.lastError')]
        .filter(Boolean)
        .join(' · ')
    : t('settings.credentials.webSearch.offHint')

  return (
    <>
      <SettingsRow
        label={
          status?.provider
            ? t(`settings.credentials.webSearch.${status.provider}`)
            : t('settings.credentials.webSearch.off')
        }
        hint={hint}
      >
        {status?.provider && (
          <Tooltip content={status.lastError ?? t('settings.credentials.webSearch.working')} maxWidth={420}>
            <span
              className={cn(
                'inline-flex h-[26px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium',
                status.lastError ? 'bg-warning-tint text-warning' : 'bg-success-soft text-success',
              )}
            >
              <Search size={13} aria-hidden />
              {t('settings.credentials.webSearch.on')}
            </span>
          </Tooltip>
        )}
        <Button size="sm" onClick={() => setEditing(!editing)}>
          {connected ? <RefreshCw size={12} /> : <Plus size={12} />}
          {connected ? t('settings.credentials.webSearch.replace') : t('settings.credentials.webSearch.add')}
        </Button>
        {connected && (
          <Tooltip content={t('settings.credentials.webSearch.remove')}>
            <button
              type="button"
              aria-label={t('settings.credentials.webSearch.remove')}
              onClick={remove}
              className="focus-ring flex size-7 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-danger"
            >
              <Unplug size={13} />
            </button>
          </Tooltip>
        )}
      </SettingsRow>
      {editing && (
        <form
          className="flex flex-col gap-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim().length >= 10 && !busy) void save()
          }}
        >
          <Segmented
            size="sm"
            className="w-fit"
            label={t('settings.credentials.webSearch.service')}
            value={provider}
            options={[
              { value: 'brave', label: t('settings.credentials.webSearch.brave') },
              { value: 'tavily', label: t('settings.credentials.webSearch.tavily') },
            ]}
            onChange={setProvider}
          />
          <p className="text-sm text-fg-secondary">
            {t('settings.credentials.webSearch.howTo')}{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => void window.milibot.openExternal(SIGN_UP[provider])}
            >
              {t('settings.credentials.webSearch.createLink', {
                service: t(`settings.credentials.webSearch.${provider}`),
              })}
            </button>
          </p>
          <div className="flex gap-2">
            <TextInput
              data-autofocus
              autoFocus
              type="password"
              autoComplete="off"
              placeholder={PLACEHOLDER[provider]}
              className="font-mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button variant="primary" type="submit" disabled={busy || key.trim().length < 10}>
              {busy && <Spinner size={13} />}
              {t('settings.credentials.webSearch.check')}
            </Button>
          </div>
          <p className="text-xs leading-[15px] text-fg-muted">
            {t('settings.credentials.webSearch.privacy')}
          </p>
          {error !== null && (
            <ErrorLine
              message={
                isApiError(error, 'validation_failed')
                  ? t('settings.credentials.webSearch.checkFailed')
                  : t('toast.error')
              }
              detail={errorMessage(error)}
            />
          )}
        </form>
      )}
    </>
  )
}
