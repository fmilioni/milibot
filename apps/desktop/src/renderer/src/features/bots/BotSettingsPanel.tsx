import type { Bot, ReasoningEffort } from '@milibot/shared'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AvatarEditor } from '@/features/bots/avatar/AvatarEditor'
import { describeConversation } from '@/features/chat/lib/conversation'
import {
  contextOptions,
  effortForModel,
  effortOptions,
  MODEL_DEFAULT,
  modelOptions,
  outputOptions,
} from '@/features/providers/lib/models'
import { useProviderModels } from '@/features/providers/use-provider-models'
import { useWorkspacePreferences } from '@/features/settings/store'
import { RightPanelHeader } from '@/features/workspace/RightPanelHeader'
import { useAppStore, useSelectedConversation } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useDraft } from '@/hooks/use-draft'
import { Select } from '@/ui/Select'
import { Switch } from '@/ui/Switch'
import { FieldLabel, TextArea, TextInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

import { BotMcpSection } from './BotMcpSection'
import { BotMemorySection } from './BotMemorySection'
import { BotProceduresSection } from './BotProceduresSection'
import { BotRoutinesSection } from './BotRoutinesSection'
import { BotSkillsSection } from './BotSkillsSection'

export function BotSettingsPanel() {
  const { t } = useTranslation()
  const conversation = useSelectedConversation()
  const bots = useAppStore((s) => s.bots)
  const bot = conversation ? describeConversation(conversation, bots, '').primaryBot : null
  return (
    <>
      <RightPanelHeader variant="bar" title={t('panels.bot.title')} />
      {bot ? (
        <BotSettingsForm key={bot.id} bot={bot} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-10 text-center text-base text-fg-muted">
          {t('panels.bot.noBot')}
        </div>
      )}
    </>
  )
}

function BotSettingsForm({ bot }: { bot: Bot }) {
  const { t, i18n } = useTranslation()
  const updateBot = useAppStore((s) => s.updateBot)
  const setModal = useAppStore((s) => s.setModal)
  const conversation = useSelectedConversation()
  const [name, setName] = useDraft(bot.name)
  const [label, setLabel] = useDraft(bot.label)
  const persona = bot.systemPrompt.trim()
  const lastBot = useAppStore((s) => Object.keys(s.bots).length <= 1)
  const [prompt, setPrompt] = useDraft(persona)
  const workspaceId = useWorkspaceId()
  const { prefs, loaded, set: setPreferences } = useWorkspacePreferences(workspaceId)
  const providerModels = useProviderModels(bot.providerId)
  const currentModel = bot.model ?? providerModels.defaultModel
  const options = modelOptions(t, providerModels, currentModel)
  const modelInfo = providerModels.models.find((m) => m.id === currentModel) ?? null
  const efforts = effortOptions(t, modelInfo)

  const save = (patch: { name?: string; label?: string; systemPrompt?: string }) => {
    const current = { name: bot.name, label: bot.label, systemPrompt: persona }
    const changed = Object.entries(patch).some(([k, v]) => current[k as keyof typeof patch] !== v)
    if (changed) void updateBot(bot.id, patch)
  }

  const created = new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: '2-digit' }).format(
    bot.createdAt,
  )
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) =>
    e.key === 'Enter' && e.currentTarget.blur()

  return (
    <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-5">
      <AvatarEditor
        value={bot.avatar}
        state={bot.status}
        variant="panel"
        onChange={(avatar) => void updateBot(bot.id, { avatar })}
      />
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="bot-name">{t('panels.bot.name')}</FieldLabel>
        <TextInput
          id="bot-name"
          tone="surface-2"
          value={name}
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => (name.trim() ? save({ name: name.trim() }) : setName(bot.name))}
          onKeyDown={blurOnEnter}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="bot-label">{t('panels.bot.label')}</FieldLabel>
        <TextInput
          id="bot-label"
          tone="surface-2"
          value={label}
          maxLength={32}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => save({ label: label.trim() })}
          onKeyDown={blurOnEnter}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="bot-prompt" hint={t('panels.bot.createdAt', { date: created })}>
          {t('panels.bot.systemPrompt')}
        </FieldLabel>
        <TextArea
          id="bot-prompt"
          tone="surface-2"
          rows={4}
          className="max-h-80 min-h-[98px] [field-sizing:content]"
          value={prompt}
          placeholder={t('panels.bot.systemPromptPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => save({ systemPrompt: prompt.trim() })}
        />
      </div>
      <div className="flex flex-col rounded-[10px] border border-border bg-surface-2">
        <div className="flex items-center gap-3 border-b border-border px-3.5 py-[11px]">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base text-fg">{t('panels.bot.model')}</span>
            <span className="text-xs text-fg-muted">{t('panels.bot.modelHint')}</span>
          </div>
          <div className="w-[209px]">
            {currentModel && options.length > 0 ? (
              <Select
                size="sm"
                tone="surface-2"
                value={currentModel}
                label={t('panels.bot.model')}
                options={options}
                onChange={(model) =>
                  model !== currentModel &&
                  void updateBot(bot.id, {
                    model,
                    effort: effortForModel(
                      bot.effort,
                      providerModels.models.find((m) => m.id === model),
                    ),
                  })
                }
              />
            ) : (
              <Select
                size="sm"
                tone="surface-2"
                value="current"
                label={t('panels.bot.model')}
                disabled
                options={[{ value: 'current', label: bot.model ?? t('panels.bot.defaultModel') }]}
                onChange={() => undefined}
              />
            )}
          </div>
        </div>
        <PrefRow label={t('panels.bot.effort')} hint={t('panels.bot.effortHint')}>
          <Select
            size="sm"
            tone="surface-2"
            label={t('panels.bot.effort')}
            disabled={efforts.length === 0}
            value={efforts.length ? (bot.effort ?? MODEL_DEFAULT) : 'none'}
            options={efforts.length ? efforts : [{ value: 'none', label: t('reasoningEffort.none') }]}
            onChange={(value) =>
              void updateBot(bot.id, { effort: value === MODEL_DEFAULT ? null : (value as ReasoningEffort) })
            }
          />
        </PrefRow>
        <PrefRow label={t('panels.bot.context')} hint={t('panels.bot.contextHint')}>
          <Select
            size="sm"
            tone="surface-2"
            label={t('panels.bot.context')}
            value={bot.contextLimit ? String(bot.contextLimit) : MODEL_DEFAULT}
            options={contextOptions(t, modelInfo?.contextWindow, bot.contextLimit)}
            onChange={(value) =>
              void updateBot(bot.id, { contextLimit: value === MODEL_DEFAULT ? null : Number(value) })
            }
          />
        </PrefRow>
        <PrefRow label={t('panels.bot.maxOutput')} hint={t('panels.bot.maxOutputHint')}>
          <Select
            size="sm"
            tone="surface-2"
            label={t('panels.bot.maxOutput')}
            value={bot.maxOutputTokens ? String(bot.maxOutputTokens) : MODEL_DEFAULT}
            options={outputOptions(t, bot.maxOutputTokens)}
            onChange={(value) =>
              void updateBot(bot.id, { maxOutputTokens: value === MODEL_DEFAULT ? null : Number(value) })
            }
          />
        </PrefRow>
        <div className="flex items-center gap-3 px-3.5 py-[11px]">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base text-fg">{t('panels.bot.notifications')}</span>
            <span className="text-xs text-fg-muted">{t('panels.bot.notificationsHint')}</span>
          </div>
          <Switch
            checked={!loaded || !prefs.mutedBots.includes(bot.id)}
            disabled={!loaded}
            label={t('panels.bot.notifications')}
            onChange={(value) => {
              const others = prefs.mutedBots.filter((id) => id !== bot.id)
              void setPreferences({ mutedBots: value ? others : [...others, bot.id] })
            }}
          />
        </div>
      </div>
      <BotSkillsSection bot={bot} />
      <BotMcpSection bot={bot} />
      <BotProceduresSection bot={bot} />
      <BotMemorySection bot={bot} />
      <BotRoutinesSection bot={bot} />
      {conversation && (
        <Tooltip content={lastBot ? t('panels.bot.deleteLastBot') : null}>
          <button
            type="button"
            aria-disabled={lastBot || undefined}
            onClick={() => !lastBot && setModal({ type: 'confirmDelete', conversationId: conversation.id })}
            className="focus-ring flex w-fit items-center gap-2 rounded pt-1 text-base font-medium text-danger hover:underline aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:no-underline"
          >
            <Trash2 size={14} />
            {t('panels.bot.delete')}
          </button>
        </Tooltip>
      )}
    </div>
  )
}

function PrefRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3.5 py-[11px]">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base text-fg">{label}</span>
        <span className="text-xs text-fg-muted">{hint}</span>
      </div>
      <div className="w-[209px]">{children}</div>
    </div>
  )
}
