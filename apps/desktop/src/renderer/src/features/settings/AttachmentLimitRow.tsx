import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { useAttachmentStore } from '@/features/chat/attachment-store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Select } from '@/ui/Select'

import { getAttachmentSettings, updateAttachmentSettings } from './api'
import { SettingsRow } from './SettingsLayout'

const LIMITS_MB = [10, 25, 50, 100, 250, 500, 1024]

/** Per file attached in the chat. */
export function AttachmentLimitRow() {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const saved = useApiQuery(queryKeys.attachmentSettings(workspaceId), () =>
    getAttachmentSettings(workspaceId),
  ).data
  const [chosen, setChosen] = useState<number | null>(null)
  const save = useApiMutation((maxFileMb: number) => updateAttachmentSettings(workspaceId, maxFileMb), {
    invalidates: [queryKeys.attachmentSettings(workspaceId)],
    onSuccess: (settings) => {
      setChosen(settings.maxFileMb)
      if (useAttachmentStore.getState().workspaceId === workspaceId)
        useAttachmentStore.setState({ maxFileMb: settings.maxFileMb })
    },
  })
  const maxFileMb = chosen ?? saved?.maxFileMb ?? null

  const label = (mb: number) =>
    mb >= 1024
      ? t('settings.general.attachmentLimitGb', {
          value: new Intl.NumberFormat(i18n.language).format(mb / 1024),
        })
      : t('settings.general.attachmentLimitMb', { value: mb })
  const options = [...new Set([...LIMITS_MB, ...(maxFileMb ? [maxFileMb] : [])])]
    .sort((a, b) => a - b)
    .map((mb) => ({ value: String(mb), label: label(mb) }))

  return (
    <SettingsRow
      label={t('settings.general.attachmentLimit')}
      hint={t('settings.general.attachmentLimitHint')}
    >
      <div className="w-[210px]">
        <Select
          label={t('settings.general.attachmentLimit')}
          value={maxFileMb ? String(maxFileMb) : '50'}
          disabled={maxFileMb === null}
          options={options}
          size="sm"
          tone="surface-2"
          onChange={(value) => {
            const next = Number(value)
            setChosen(next)
            void save.run(next)
          }}
        />
      </div>
    </SettingsRow>
  )
}
