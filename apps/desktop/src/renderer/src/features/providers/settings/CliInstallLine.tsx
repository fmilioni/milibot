import type { CliEngine } from '@milibot/shared'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getCliInstall, installCli } from '@/features/providers/api'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cliTextParams } from '@/lib/cli-engines'
import { Button } from '@/ui/Button'

/** An engine whose CLI Milibot installs in the VM: shown while it installs, or when it failed. */
export function CliInstallLine({ engine, vmRunning }: { engine: CliEngine; vmRunning: boolean }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const params = cliTextParams(engine)
  const { data, reload } = useApiQuery(
    queryKeys.cliInstall(workspaceId, engine),
    () => getCliInstall(workspaceId, engine),
    { enabled: vmRunning },
  )
  const install = useApiMutation(() => installCli(workspaceId, engine), {
    invalidates: [queryKeys.cliInstall(workspaceId, engine)],
    errorToast: false,
  })
  useEffect(() => {
    if (!data?.installing) return
    const timer = setTimeout(reload, 3000)
    return () => clearTimeout(timer)
  }, [data, reload])
  if (!vmRunning || !data || (data.version === data.expected && !data.installing)) return null
  const retry = () => install.run().catch(reload)
  if (data.installing || install.busy)
    return <p className="text-sm text-fg-secondary">{t('settings.providers.cli.installing', params)}</p>
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-sm text-danger">
        {data.error
          ? t('settings.providers.cli.installFailed', params)
          : t('settings.providers.cli.notInstalled', params)}
      </span>
      <Button size="sm" variant="ghost" onClick={() => void retry()}>
        {t('settings.providers.cli.install')}
      </Button>
    </div>
  )
}
