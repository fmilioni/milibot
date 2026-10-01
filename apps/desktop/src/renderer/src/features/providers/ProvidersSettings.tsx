import { CLI_ENGINES, type CliEngine, isCliEngine } from '@milibot/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { addCliProvider, useProvidersData } from '@/features/providers/api'
import { KeyringNotice } from '@/features/settings/HostWarnings'
import { SettingsPage } from '@/features/settings/SettingsLayout'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cliTextParams } from '@/lib/cli-engines'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'

import { ProviderForm } from './ProviderForm'
import { ApiProviderCard } from './settings/ApiProviderCard'
import { CliProviderCard } from './settings/CliProviderCard'
import { DefaultModels } from './settings/DefaultModels'

export function ProvidersSettings() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const openSettings = useAppStore((s) => s.openSettings)
  const { data, error, reload } = useProvidersData(workspaceId)
  const [form, setForm] = useState<{ providerId: string | null } | null>(null)
  const addCli = useApiMutation((engine: CliEngine) => addCliProvider(workspaceId, engine), {
    invalidates: [queryKeys.providers(workspaceId)],
  })

  return (
    <SettingsPage
      title={t('settings.sections.providers')}
      subtitle={t('settings.providers.subtitle')}
      width="wide"
      actions={
        <Button
          variant="primary"
          onClick={() => setForm({ providerId: null })}
          disabled={form?.providerId === null}
        >
          <Plus size={13} />
          {t('settings.providers.add')}
        </Button>
      }
    >
      <KeyringNotice />
      <AsyncView data={data} error={error} onRetry={reload}>
        {(data) => (
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <ul className="flex min-w-0 flex-col gap-3">
              {data.providers.map((provider) =>
                isCliEngine(provider.type) ? (
                  <CliProviderCard
                    key={provider.id}
                    provider={provider}
                    engine={provider.type}
                    onChanged={reload}
                  />
                ) : form?.providerId === provider.id ? (
                  <li key={provider.id}>
                    <ProviderForm
                      provider={provider}
                      savedModels={data.models[provider.id]?.chat ?? []}
                      savedEmbeddingModels={data.models[provider.id]?.embedding ?? []}
                      savedImageModels={data.models[provider.id]?.image ?? []}
                      onClose={() => setForm(null)}
                      onOpenKnowledge={() => openSettings('knowledge')}
                      onSaved={() => setForm(null)}
                    />
                  </li>
                ) : (
                  <ApiProviderCard
                    key={provider.id}
                    provider={provider}
                    models={data.models[provider.id]?.chat ?? []}
                    embeddingModels={
                      (data.models[provider.id]?.embedding ?? []).filter((m) => m.enabled).length
                    }
                    onEdit={() => setForm({ providerId: provider.id })}
                    onChanged={reload}
                  />
                ),
              )}
              {form?.providerId === null && (
                <li>
                  <ProviderForm
                    onClose={() => setForm(null)}
                    onOpenKnowledge={() => openSettings('knowledge')}
                    onSaved={() => setForm(null)}
                  />
                </li>
              )}
              {CLI_ENGINES.filter((engine) => !data.providers.some((p) => p.type === engine)).map(
                (engine) => (
                  <li
                    key={engine}
                    className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3.5 py-3"
                  >
                    <span className="min-w-0 flex-1 text-base text-fg-secondary">
                      {t('settings.providers.cli.missing', cliTextParams(engine))}
                    </span>
                    <Button size="sm" disabled={addCli.busy} onClick={() => void addCli.run(engine)}>
                      <Plus size={13} />
                      {t('settings.providers.cli.add', cliTextParams(engine))}
                    </Button>
                  </li>
                ),
              )}
            </ul>
            <DefaultModels data={data} onEditProvider={(providerId) => setForm({ providerId })} />
          </div>
        )}
      </AsyncView>
    </SettingsPage>
  )
}
