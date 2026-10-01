import type { Provider } from '@milibot/shared'
import { Pencil, Star, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { deleteProvider, updateProvider } from '@/features/providers/api'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { InlineConfirm } from '@/ui/Confirm'
import type { MenuEntry } from '@/ui/Menu'
import { MoreMenu } from '@/ui/MoreMenu'

/** The "⋯" menu of a provider card, plus the delete confirmation strip it opens under the card. */
export function ProviderMenu({
  provider,
  onEdit,
  onChanged,
}: {
  provider: Provider
  onEdit?: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const invalidates = [queryKeys.providers(workspaceId)]
  const makeDefault = useApiMutation(() => updateProvider(workspaceId, provider.id, { isDefault: true }), {
    invalidates,
    onSuccess: onChanged,
  })
  const remove = useApiMutation(() => deleteProvider(workspaceId, provider.id), {
    invalidates,
    onSuccess: onChanged,
  })
  const [confirming, setConfirming] = useState(false)
  const entries: MenuEntry[] = [
    ...(onEdit
      ? [{ key: 'edit', label: t('settings.providers.edit'), icon: <Pencil size={14} />, onSelect: onEdit }]
      : []),
    {
      key: 'default',
      label: t('settings.providers.makeDefault'),
      icon: <Star size={14} />,
      disabled: provider.isDefault,
      onSelect: () => void makeDefault.run(),
    },
    { type: 'separator', key: 'sep' },
    {
      key: 'delete',
      label: t('settings.providers.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setConfirming(true),
    },
  ]
  return (
    <>
      <MoreMenu
        label={t('settings.providers.more', { name: provider.name })}
        entries={entries}
        menuLabel={provider.name}
      />
      {confirming && (
        <InlineConfirm
          message={t('settings.providers.deleteConfirm', { name: provider.name })}
          confirmLabel={t('settings.providers.delete')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove.run()}
        />
      )}
    </>
  )
}
