import { Info, Plus, RefreshCw, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatPrice } from '@/features/knowledge/lib/knowledge'
import { blankEmbeddingRow } from '@/features/providers/lib/provider-form'
import { EmbeddingModelsTable } from '@/features/providers/tables/EmbeddingModelsTable'
import { Notice } from '@/features/settings/SettingsLayout'
import { Button, LinkButton } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

import { EmbeddingPicker } from '../EmbeddingPicker'
import type { EmbeddingModels } from './use-embedding-models'

export function EmbeddingModelsSection({
  models,
  urlValid,
  openRouter,
  providerName,
  onOpenKnowledge,
}: {
  models: EmbeddingModels
  urlValid: boolean
  openRouter: boolean
  providerName: string
  onOpenKnowledge: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation()
  const { fetching } = models
  return (
    <>
      <div className="mt-1 flex flex-col gap-1.5">
        <h4 className="text-sm font-semibold text-fg">{t('settings.providers.embedding.title')}</h4>
        <Notice icon={<Info size={13} />}>
          <p>{t('settings.providers.embedding.hint')}</p>
          {onOpenKnowledge && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="outline" onClick={onOpenKnowledge}>
                {t('settings.providers.embedding.openKnowledge')}
              </Button>
            </div>
          )}
        </Notice>
      </div>
      <EmbeddingModelsTable
        rows={models.rows}
        setRows={models.setRows}
        tests={models.tests}
        onTest={(row) => void models.test(row)}
      />
      <div className="flex flex-wrap items-center gap-4">
        <LinkButton
          disabled={fetching !== null || !urlValid}
          onClick={() => void models.fetchList()}
          className="inline-flex items-center gap-1.5"
        >
          {fetching === 'list' ? <Spinner size={13} /> : <RefreshCw size={13} />}
          {t('settings.providers.form.fetch')}
        </LinkButton>
        <LinkButton
          onClick={() => models.setRows((all) => [...all, blankEmbeddingRow()])}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={13} />
          {t('settings.providers.form.addManual')}
        </LinkButton>
        {openRouter && (
          <LinkButton
            disabled={fetching !== null || !urlValid}
            onClick={() => void models.addSuggested(false)}
            className="inline-flex items-center gap-1.5"
          >
            {fetching === 'suggest' ? <Spinner size={13} /> : <Sparkles size={13} />}
            {t('settings.providers.embedding.suggest')}
          </LinkButton>
        )}
        <span className="ml-auto text-xs text-fg-muted">
          {openRouter
            ? t('settings.providers.embedding.pricesAuto')
            : t('settings.providers.embedding.pricesUnit')}
        </span>
      </div>
      {models.note && <p className="selectable text-sm text-danger">{models.note}</p>}
      {models.listing && (
        <EmbeddingPicker
          listing={models.listing}
          providerName={providerName}
          rows={models.rows}
          formatPrice={(usd) => formatPrice(usd, i18n.language)}
          onClose={models.closeListing}
          onAdd={models.addPicked}
        />
      )}
    </>
  )
}
