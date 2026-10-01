import type { Provider, ProviderModel } from '@milibot/shared'
import { KeyRound, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getProviderAccount } from '@/features/providers/api'
import { isOpenRouter } from '@/features/providers/lib/provider-form'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { formatUsd } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Tag } from '@/ui/Tag'

import { ProviderMenu } from './ProviderMenu'

export function ApiProviderCard({
  provider,
  models,
  embeddingModels,
  onEdit,
  onChanged,
}: {
  provider: Provider
  models: ProviderModel[]
  embeddingModels: number
  onEdit: () => void
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const openRouter = isOpenRouter(provider)
  const withAccount = openRouter && provider.hasSecret
  const { data: account } = useApiQuery(
    queryKeys.providerAccount(workspaceId, provider.id),
    () => getProviderAccount(workspaceId, provider.id),
    { enabled: withAccount },
  )
  const enabled = models.filter((m) => m.enabled).length
  const facts = [
    provider.type === 'openai_compatible'
      ? openRouter
        ? t('settings.providers.modelsAvailable', { count: models.length })
        : t('settings.providers.modelsEnabled', { count: enabled })
      : null,
    embeddingModels > 0 ? t('settings.providers.searchModels', { count: embeddingModels }) : null,
    openRouter ? t('settings.providers.pricesAuto') : null,
    account?.creditUsd != null
      ? t('settings.providers.credit', { value: formatUsd(account.creditUsd, i18n.language) })
      : null,
  ].filter(Boolean)
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <span className="text-md font-semibold text-fg">{provider.name}</span>
      <Tag>
        {t(`settings.providers.types.${provider.type === 'anthropic' ? 'anthropic' : 'openai_compatible'}`)}
      </Tag>
      {provider.isDefault && <Tag tone="success">{t('settings.providers.default')}</Tag>}
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" onClick={onEdit}>
        <Pencil size={12} />
        {t('settings.providers.edit')}
      </Button>
      <ProviderMenu provider={provider} onEdit={onEdit} onChanged={onChanged} />
      <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
          <KeyRound size={12} aria-hidden />
          <span className="truncate">
            {provider.hasSecret ? t('settings.providers.keySaved') : t('settings.providers.noKey')}
            {provider.baseUrl && !openRouter ? ` · ${provider.baseUrl}` : ''}
          </span>
        </span>
        <span className="ml-auto text-sm text-fg-secondary">{facts.join(' · ')}</span>
      </div>
    </li>
  )
}
