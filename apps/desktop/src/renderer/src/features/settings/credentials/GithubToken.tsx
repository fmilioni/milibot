import type { GithubStatus } from '@milibot/shared'
import { GitBranch, Plus, RefreshCw, Unplug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { deleteGithubToken, setGithubToken, syncGithub } from '@/features/settings/api'
import { ErrorLine, SettingsRow } from '@/features/settings/SettingsLayout'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { errorMessage, isApiError } from '@/lib/errors'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'
import { TextInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

const DAY = 86_400_000

/** The GitHub token row: account, expiry and VM sync facts, connect/replace/disconnect. */
export function GithubToken({ status }: { status: GithubStatus | null }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<unknown>(null)
  const invalidates = [queryKeys.credentials(workspaceId, 'github')]
  const saveToken = useApiMutation((value: string) => setGithubToken(workspaceId, value), {
    invalidates,
    errorToast: false,
  })
  const busy = saveToken.busy
  const sync = useApiMutation(() => syncGithub(workspaceId), { invalidates })
  const disconnect = useApiMutation(() => deleteGithubToken(workspaceId), { invalidates })

  const save = async () => {
    setError(null)
    try {
      await saveToken.run(token.trim())
      setEditing(false)
      setToken('')
    } catch (err) {
      setError(err)
    }
  }

  const now = useNow(60_000)
  const facts: string[] = []
  if (status?.connected) {
    facts.push(t(`settings.credentials.github.kind.${status.tokenKind ?? 'other'}`))
    if (status.expiresAt) {
      const days = Math.ceil((status.expiresAt - now) / DAY)
      facts.push(
        days > 0
          ? t('settings.credentials.github.expiresIn', { count: days })
          : t('settings.credentials.github.expired'),
      )
    } else facts.push(t('settings.credentials.github.noExpiry'))
    if (status.sync.at && status.sync.ok === false) facts.push(t('settings.credentials.github.syncFailed'))
    else if (status.sync.at)
      facts.push(
        t('settings.credentials.github.synced', {
          count: status.sync.users,
          time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(status.sync.at),
        }),
      )
  }

  return (
    <>
      <SettingsRow
        label={
          status?.connected
            ? t('settings.credentials.github.connected')
            : t('settings.credentials.github.token')
        }
        hint={status?.connected ? facts.join(' · ') : t('settings.credentials.github.tokenHint')}
      >
        {status?.connected && (
          <span className="inline-flex h-[26px] items-center gap-1.5 rounded-lg bg-success-soft px-2.5 text-sm font-medium text-success">
            <GitBranch size={13} aria-hidden />@{status.login ?? '?'}
          </span>
        )}
        {status?.connected && (
          <Tooltip content={status.sync.error ?? t('settings.credentials.github.resync')} maxWidth={420}>
            <button
              type="button"
              aria-label={t('settings.credentials.github.resync')}
              onClick={() => void sync.run()}
              className="focus-ring flex size-7 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3"
            >
              <RefreshCw size={13} />
            </button>
          </Tooltip>
        )}
        <Button size="sm" onClick={() => setEditing(!editing)}>
          {status?.connected ? <RefreshCw size={12} /> : <Plus size={12} />}
          {status?.connected
            ? t('settings.credentials.github.replace')
            : t('settings.credentials.github.connect')}
        </Button>
        {status?.connected && (
          <Tooltip content={t('settings.credentials.github.disconnect')}>
            <button
              type="button"
              aria-label={t('settings.credentials.github.disconnect')}
              onClick={() => void disconnect.run()}
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
            if (token.trim().length >= 10 && !busy) void save()
          }}
        >
          <p className="text-sm text-fg-secondary">
            {t('settings.credentials.github.howTo')}{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() =>
                void window.milibot.openExternal('https://github.com/settings/personal-access-tokens/new')
              }
            >
              {t('settings.credentials.github.createLink')}
            </button>
          </p>
          <div className="flex gap-2">
            <TextInput
              data-autofocus
              autoFocus
              type="password"
              autoComplete="off"
              placeholder="github_pat_…"
              className="font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button variant="primary" type="submit" disabled={busy || token.trim().length < 10}>
              {busy && <Spinner size={13} />}
              {t('settings.credentials.github.check')}
            </Button>
          </div>
          {error !== null && (
            <ErrorLine
              message={
                isApiError(error, 'validation_failed')
                  ? t('settings.credentials.github.checkFailed')
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
