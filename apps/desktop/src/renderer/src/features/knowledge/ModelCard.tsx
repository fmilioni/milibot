import type { KnowledgeEmbeddingSetting } from '@milibot/shared'
import { ArrowRight, Cloud, Info, Laptop } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { probeEmbeddingModel } from '@/features/knowledge/api'
import {
  apiEmbeddingModel,
  decodeEmbedding,
  embeddingChoices,
  embeddingTriggerParts,
  indexStatusView,
  isSameEmbedding,
} from '@/features/knowledge/lib/knowledge'
import { SettingsCard, SettingsRow } from '@/features/settings/SettingsLayout'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { LinkButton } from '@/ui/Button'
import { Select } from '@/ui/Select'
import { Spinner } from '@/ui/Spinner'
import { Switch } from '@/ui/Switch'

import { StatusStrip } from './StatusStrip'
import { useKnowledgeStore } from './store'

function IndexStatus() {
  const { t, i18n } = useTranslation()
  const index = useKnowledgeStore((s) => s.index)
  const options = useKnowledgeStore((s) => s.options)
  const retryIndex = useKnowledgeStore((s) => s.retryIndex)
  const workspaceId = useWorkspaceId()
  if (!index) return null
  const view = indexStatusView(index, options, t, i18n.language)
  return (
    <StatusStrip
      tone={view.tone}
      text={view.text}
      progress={view.progress}
      error={view.error}
      {...(view.retry ? { onRetry: () => void toastOnError(retryIndex(workspaceId)) } : {})}
    />
  )
}

type ProbeState = { status: 'probing'; model: string } | { status: 'failed'; model: string; reason: string }

function EmbeddingSelect() {
  const { t, i18n } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const workspaceId = useWorkspaceId()
  const openSettings = useAppStore((s) => s.openSettings)
  const options = useKnowledgeStore((s) => s.options)
  const settings = useKnowledgeStore((s) => s.settings)
  const updateSettings = useKnowledgeStore((s) => s.updateSettings)
  const [probe, setProbe] = useState<ProbeState | null>(null)
  const choices = useMemo(
    () =>
      options
        ? embeddingChoices(settings ? { ...options, current: settings.embedding } : options, t, i18n.language)
        : null,
    [options, settings, t, i18n.language],
  )
  if (!choices || !options)
    return <div className="h-[34px] w-[460px] animate-pulse rounded-[7px] bg-surface-3/60" />

  const groups = Object.fromEntries(
    Object.entries(choices.groups).map(([key, info]) => [
      key,
      {
        ...info,
        tag: info.tag && {
          ...info.tag,
          icon: info.where === 'mac' ? <Laptop size={11} aria-hidden /> : <Cloud size={11} aria-hidden />,
        },
      },
    ]),
  )

  /** A model never tested (size unknown) is tried once before it becomes the setting. */
  const choose = async (embedding: KnowledgeEmbeddingSetting) => {
    const registered = apiEmbeddingModel(options, embedding)
    if (embedding.provider === 'api' && registered && registered.dimensions === null && workspaceId) {
      setProbe({ status: 'probing', model: registered.name })
      const result = await probeEmbeddingModel(workspaceId, embedding.providerId, embedding.model).catch(
        () => null,
      )
      if (!result?.ok) {
        const code = result?.errorCode ?? 'unreachable'
        setProbe({
          status: 'failed',
          model: registered.name,
          reason: t(`settings.providers.embedding.errors.${code}`),
        })
        return
      }
    }
    setProbe(null)
    await updateSettings(workspaceId, { embedding })
  }

  return (
    <div className="flex w-[460px] max-w-full flex-col gap-1">
      <Select
        label={t('knowledge.model.label')}
        value={choices.value}
        options={choices.options}
        groups={groups}
        menuWidth={460}
        menuAlign="end"
        disabled={probe?.status === 'probing'}
        onChange={(value) => {
          const embedding = decodeEmbedding(value)
          if (!embedding || (settings && isSameEmbedding(embedding, settings.embedding))) return
          void choose(embedding).catch(() => {
            setProbe(null)
            showToast('error')
          })
        }}
        renderValue={() => {
          const parts = embeddingTriggerParts(choices, choices.value)
          return (
            <>
              {parts.where && <span className="shrink-0 text-fg-muted">{parts.where} ·</span>}
              <span className="min-w-0 truncate">{parts.name}</span>
              {parts.badge && (
                <span className="shrink-0 rounded-[5px] bg-accent-soft px-1.5 text-xs leading-4 font-semibold text-accent">
                  {parts.badge}
                </span>
              )}
            </>
          )
        }}
        footer={
          <div className="flex flex-col gap-1.5">
            <span className="flex items-start gap-1.5 text-xs leading-[14px] text-fg-muted">
              <Info size={12} className="mt-px shrink-0" aria-hidden />
              {t('knowledge.model.footer')}
            </span>
            <LinkButton
              onClick={() => openSettings('providers')}
              className="inline-flex w-fit items-center gap-1 text-xs"
            >
              {t('knowledge.model.register')}
              <ArrowRight size={12} aria-hidden />
            </LinkButton>
          </div>
        }
      />
      {probe && (
        <p
          role={probe.status === 'failed' ? 'alert' : 'status'}
          className={cn(
            'flex items-center gap-1.5 text-xs leading-[14px]',
            probe.status === 'failed' ? 'text-danger' : 'text-fg-muted',
          )}
        >
          {probe.status === 'probing' ? (
            <>
              <Spinner size={12} />
              {t('knowledge.model.probing', { model: probe.model })}
            </>
          ) : (
            t('knowledge.model.probeFailed', { model: probe.model, reason: probe.reason })
          )}
        </p>
      )}
    </div>
  )
}

/** "Search model" with the index status, plus the two switches that feed documents into the turns. */
export function ModelCard() {
  const { t } = useTranslation()
  const settings = useKnowledgeStore((s) => s.settings)
  const workspaceId = useWorkspaceId()
  const updateSettings = useKnowledgeStore((s) => s.updateSettings)
  const toggle = (key: 'autoRetrieve' | 'suggestDocs', value: boolean) =>
    void toastOnError(updateSettings(workspaceId, { [key]: value }))

  return (
    <SettingsCard className="overflow-visible">
      <SettingsRow
        label={t('knowledge.model.label')}
        hint={t('knowledge.model.hint')}
        className="min-h-[58px]"
      >
        <EmbeddingSelect />
      </SettingsRow>
      <IndexStatus />
      <SettingsRow
        label={t('knowledge.suggestDocs.label')}
        hint={t('knowledge.suggestDocs.hint')}
        className="border-t border-border"
      >
        <Switch
          checked={settings?.suggestDocs ?? true}
          disabled={!settings}
          label={t('knowledge.suggestDocs.label')}
          onChange={(value) => toggle('suggestDocs', value)}
        />
      </SettingsRow>
      <SettingsRow label={t('knowledge.autoRetrieve.label')} hint={t('knowledge.autoRetrieve.hint')}>
        <Switch
          checked={settings?.autoRetrieve ?? false}
          disabled={!settings}
          label={t('knowledge.autoRetrieve.label')}
          onChange={(value) => toggle('autoRetrieve', value)}
        />
      </SettingsRow>
    </SettingsCard>
  )
}
