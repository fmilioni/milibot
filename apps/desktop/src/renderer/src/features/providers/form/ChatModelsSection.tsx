import { Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { blankRow, type ModelRow } from '@/features/providers/lib/provider-form'
import { ModelsTable } from '@/features/providers/tables/ModelsTable'
import { LinkButton } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

export function ChatModelsSection({
  rows,
  setRows,
  lightModel,
  onLightModelChange,
  fetching,
  urlValid,
  openRouter,
  onFetch,
}: {
  rows: ModelRow[]
  setRows: (update: (rows: ModelRow[]) => ModelRow[]) => void
  lightModel: string | null
  onLightModelChange: (modelId: string | null) => void
  fetching: boolean
  urlValid: boolean
  openRouter: boolean
  onFetch: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <h4 className="-mb-1 text-sm font-semibold text-fg">{t('settings.providers.form.chatModels')}</h4>
      <ModelsTable
        rows={rows}
        setRows={setRows}
        lightModel={lightModel}
        onLightModelChange={onLightModelChange}
      />
      <div className="flex flex-wrap items-center gap-4">
        <LinkButton
          disabled={fetching || !urlValid}
          onClick={onFetch}
          className="inline-flex items-center gap-1.5"
        >
          {fetching ? <Spinner size={13} /> : <RefreshCw size={13} />}
          {t('settings.providers.form.fetch')}
        </LinkButton>
        <LinkButton
          onClick={() => setRows((all) => [...all, blankRow()])}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={13} />
          {t('settings.providers.form.addManual')}
        </LinkButton>
        <span className="ml-auto text-xs text-fg-muted">
          {openRouter ? t('settings.providers.form.pricesAuto') : t('settings.providers.form.pricesUnit')}
        </span>
      </div>
    </>
  )
}
