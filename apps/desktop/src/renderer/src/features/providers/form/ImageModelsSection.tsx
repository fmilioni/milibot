import { Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { blankImageRow } from '@/features/providers/lib/provider-form'
import { ImageModelsTable } from '@/features/providers/tables/ImageModelsTable'
import { formatUsd } from '@/lib/format'
import { LinkButton } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

import { ImageModelPicker } from '../ImageModelPicker'
import type { ImageModels } from './use-image-models'

export function ImageModelsSection({
  models,
  urlValid,
  providerName,
}: {
  models: ImageModels
  urlValid: boolean
  providerName: string
}) {
  const { t, i18n } = useTranslation()
  return (
    <>
      <div className="mt-1 flex flex-col gap-1.5">
        <h4 className="text-sm font-semibold text-fg">{t('settings.providers.image.title')}</h4>
        <p className="text-xs text-fg-secondary">{t('settings.providers.image.hint')}</p>
      </div>
      <ImageModelsTable rows={models.rows} setRows={models.setRows} />
      <div className="flex flex-wrap items-center gap-4">
        <LinkButton
          disabled={models.fetching || !urlValid}
          onClick={() => void models.fetchList()}
          className="inline-flex items-center gap-1.5"
        >
          {models.fetching ? <Spinner size={13} /> : <RefreshCw size={13} />}
          {t('settings.providers.form.fetch')}
        </LinkButton>
        <LinkButton
          onClick={() => models.setRows((all) => [...all, blankImageRow()])}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={13} />
          {t('settings.providers.form.addManual')}
        </LinkButton>
        <span className="ml-auto text-xs text-fg-muted">{t('settings.providers.image.pricesUnit')}</span>
      </div>
      {models.note && <p className="selectable text-sm text-danger">{models.note}</p>}
      {models.listing && (
        <ImageModelPicker
          listing={models.listing}
          providerName={providerName}
          rows={models.rows}
          formatPrice={(usd) => formatUsd(usd, i18n.language, 'cost')}
          onClose={models.closeListing}
          onAdd={models.addPicked}
        />
      )}
    </>
  )
}
