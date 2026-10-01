import type { Provider, ProviderModel } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { providerDraft } from '@/features/providers/api'
import { ErrorLine } from '@/features/settings/SettingsLayout'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { errorMessage } from '@/lib/errors'
import { Segmented } from '@/ui/Segmented'

import { ChatModelsSection } from './form/ChatModelsSection'
import { ConnectionFields } from './form/ConnectionFields'
import { EmbeddingModelsSection } from './form/EmbeddingModelsSection'
import { FormActions, type TestState } from './form/FormActions'
import { ImageModelsSection } from './form/ImageModelsSection'
import { useEmbeddingModels } from './form/use-embedding-models'
import { useImageModels } from './form/use-image-models'
import { useProviderDraft } from './form/use-provider-draft'
import { saveProviderForm } from './save-provider'

type FormError = { kind: 'save' | 'fetch'; detail: string }

/**
 * "New provider" (and editing one): OpenAI- or Anthropic-compatible endpoint, key, extra headers
 * and — for OpenAI-compatible servers — the chat models table (context, output cap, prices per 1M
 * tokens), the search models table used by Knowledge and the image models bots draw with.
 */
export function ProviderForm({
  provider,
  savedModels = [],
  savedEmbeddingModels = [],
  savedImageModels = [],
  onClose,
  onSaved,
  onOpenKnowledge,
}: {
  provider?: Provider
  savedModels?: ProviderModel[]
  savedEmbeddingModels?: ProviderModel[]
  savedImageModels?: ProviderModel[]
  onClose: () => void
  onSaved: () => void
  /** Link to Knowledge › Search model; left out where Settings can't be opened (setup). */
  onOpenKnowledge?: () => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const queryClient = useQueryClient()
  const form = useProviderDraft(provider, savedModels)
  const { state, openRouter, urlValid, draft } = form
  const { type, rows } = state
  const embeddings = useEmbeddingModels({
    workspaceId,
    draft,
    saved: savedEmbeddingModels,
    autoSuggest: !provider && openRouter && urlValid,
  })
  const images = useImageModels({ workspaceId, draft, saved: savedImageModels })
  const [fetching, setFetching] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<FormError | null>(null)
  const pickerName = state.name.trim() || (openRouter ? 'OpenRouter' : '')

  const fetchModels = async () => {
    setFetching(true)
    setError(null)
    try {
      form.applyFetched(await providerDraft.fetchModels(workspaceId, draft()))
    } catch (err) {
      setError({ kind: 'fetch', detail: errorMessage(err) })
    } finally {
      setFetching(false)
    }
  }

  const runTest = async () => {
    const model =
      rows.find((r) => r.enabled && r.modelId)?.modelId ??
      provider?.defaultModel ??
      (type === 'anthropic' ? 'claude-haiku-4-5' : undefined)
    setTest({ status: 'testing' })
    try {
      const result = await providerDraft.test(workspaceId, draft(), model)
      setTest({ status: 'done', ...result })
    } catch (err) {
      setTest({
        status: 'done',
        ok: false,
        model: model ?? null,
        supportsTools: false,
        supportsVision: false,
        latencyMs: null,
        error: errorMessage(err),
      })
    }
  }

  const save = async () => {
    if (!state.name.trim() || !urlValid) return
    setSaving(true)
    setError(null)
    try {
      await saveProviderForm(workspaceId, {
        provider,
        type,
        fields: form.saveFields(),
        savedModels,
        rows,
        savedEmbeddingModels,
        embeddingRows: embeddings.rows,
        savedImageModels,
        imageRows: images.rows,
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers(workspaceId) })
      onSaved()
    } catch (err) {
      setError({ kind: 'save', detail: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const title = provider
    ? t('settings.providers.form.editTitle', { name: provider.name })
    : t('settings.providers.form.newTitle')

  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-xl border-2 border-accent/60 bg-surface-2 p-3.5"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-md font-semibold text-fg">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="focus-ring flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3"
        >
          <X size={14} />
        </button>
      </div>
      {!provider && (
        <div className="w-fit">
          <Segmented
            label={t('settings.providers.form.type')}
            value={type}
            options={[
              { value: 'openai_compatible', label: t('settings.providers.form.openai') },
              { value: 'anthropic', label: t('settings.providers.form.anthropic') },
            ]}
            onChange={(next) => form.set({ type: next })}
          />
        </div>
      )}
      <ConnectionFields provider={provider} state={state} urlValid={urlValid} set={form.set} />

      {type === 'openai_compatible' && (
        <>
          <ChatModelsSection
            rows={rows}
            setRows={form.setRows}
            lightModel={state.lightModel}
            onLightModelChange={(lightModel) => form.set({ lightModel })}
            fetching={fetching}
            urlValid={urlValid}
            openRouter={openRouter}
            onFetch={() => void fetchModels()}
          />
          <EmbeddingModelsSection
            models={embeddings}
            urlValid={urlValid}
            openRouter={openRouter}
            providerName={pickerName}
            onOpenKnowledge={onOpenKnowledge}
          />
          <ImageModelsSection models={images} urlValid={urlValid} providerName={pickerName} />
        </>
      )}

      {error && (
        <ErrorLine
          message={
            error.kind === 'save'
              ? t('settings.providers.form.saveFailed')
              : t('settings.providers.form.fetchFailed')
          }
          detail={error.detail}
        />
      )}
      <FormActions
        test={test}
        enabledModels={type === 'openai_compatible' ? rows.filter((r) => r.enabled).length : null}
        urlValid={urlValid}
        saving={saving}
        canSave={Boolean(state.name.trim()) && urlValid}
        onTest={() => void runTest()}
        onSave={() => void save()}
      />
    </section>
  )
}
