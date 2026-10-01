import { type Avatar, estimateTokens, firstBot, randomAvatar } from '@milibot/shared'
import { ArrowLeft, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AvatarEditor } from '@/features/bots/avatar/AvatarEditor'
import { modelOptions } from '@/features/providers/lib/models'
import { useProviderModels } from '@/features/providers/use-provider-models'
import { useAppStore } from '@/features/workspace/store'
import { appLanguage } from '@/i18n'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { Select } from '@/ui/Select'
import { FieldLabel, TextArea, TextInput } from '@/ui/TextInput'

const NONE = '__none__'

export function NewBotModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const createBot = useAppStore((s) => s.createBot)
  const sections = useAppStore((s) => s.sections)
  const [avatar, setAvatar] = useState<Avatar>(() => randomAvatar())
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [sectionId, setSectionId] = useState(NONE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [step, setStep] = useState<'form' | 'prompt'>('form')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [maxTokens, setMaxTokens] = useState(1500)
  const [generating, setGenerating] = useState(false)
  const [generateFailed, setGenerateFailed] = useState(false)
  const [generatedFrom, setGeneratedFrom] = useState<string | null>(null)
  const generateBotPrompt = useAppStore((s) => s.generateBotPrompt)
  const language = useAppStore((s) => s.appSettings.language)
  const coordinator = useAppStore((s) => firstBot(Object.values(s.bots))?.name ?? null)
  const promptTokens = estimateTokens(systemPrompt.trim())
  const promptTooLong = promptTokens > maxTokens
  const providerModels = useProviderModels(null)
  const [model, setModel] = useState<string | null>(null)
  const selectedModel = model ?? providerModels.defaultModel
  const options = modelOptions(t, providerModels, selectedModel)

  const generate = async () => {
    if (generating) return
    setGenerating(true)
    setGenerateFailed(false)
    try {
      const draft = await generateBotPrompt({
        name: name.trim(),
        label: label.trim(),
        description: description.trim(),
        language: language ?? appLanguage(),
      })
      setSystemPrompt(draft.systemPrompt)
      setMaxTokens(draft.maxTokens)
      setGeneratedFrom(description.trim())
      setStep('prompt')
    } catch {
      setGenerateFailed(true)
    } finally {
      setGenerating(false)
    }
  }

  const applyDescription = () => {
    setSystemPrompt(description.trim())
    setGenerateFailed(false)
    setStep('prompt')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy || generating) return
    if (step === 'form' && description.trim()) {
      if (systemPrompt.trim() && generatedFrom === description.trim()) setStep('prompt')
      else void generate()
      return
    }
    if (step === 'prompt' && promptTooLong) return
    setBusy(true)
    setError(false)
    try {
      await createBot({
        name: name.trim(),
        label: label.trim(),
        systemPrompt: step === 'prompt' ? systemPrompt.trim() : '',
        avatar,
        sectionId: sectionId === NONE ? null : sectionId,
        model: selectedModel && selectedModel !== providerModels.defaultModel ? selectedModel : null,
      })
      onClose()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const promptStep = (
    <>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => setStep('form')}
          aria-label={t('newBot.back')}
          className="focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-base font-semibold text-fg">
            {label.trim() ? `${name.trim()} · ${label.trim()}` : name.trim()}
          </span>
          <span className="text-sm text-fg-muted">{t('newBot.promptHint')}</span>
        </div>
      </div>
      <div className="flex flex-col gap-[5px]">
        <div className="flex items-baseline justify-between">
          <FieldLabel htmlFor="new-bot-prompt">{t('newBot.prompt')}</FieldLabel>
          <span className={cn('text-xs', promptTooLong ? 'font-semibold text-danger' : 'text-fg-muted')}>
            {t('newBot.promptTokens', {
              tokens: promptTokens.toLocaleString(i18n.language),
              max: maxTokens.toLocaleString(i18n.language),
            })}
          </span>
        </div>
        <TextArea
          id="new-bot-prompt"
          data-autofocus
          rows={14}
          className="h-[300px] text-base"
          value={systemPrompt}
          disabled={generating}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
        {promptTooLong && <span className="text-sm text-danger">{t('newBot.promptTooLong')}</span>}
      </div>
      {generateFailed && <div className="text-sm text-danger">{t('newBot.generateFailed')}</div>}
      {error && <div className="text-sm text-danger">{t('newBot.failed')}</div>}
      <div className="flex items-center gap-2.5">
        <Button
          variant="outline"
          className="h-[34px]"
          disabled={generating || busy || !description.trim()}
          onClick={() => void generate()}
        >
          {generating ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {generating ? t('newBot.generating') : t('newBot.regenerate')}
        </Button>
        <span className="flex-1" />
        <Button
          type="submit"
          variant="primary"
          className="h-[34px] px-4"
          disabled={!name.trim() || !systemPrompt.trim() || promptTooLong || busy || generating}
        >
          {t('newBot.create')}
        </Button>
      </div>
    </>
  )

  return (
    <Modal title={t('newBot.title')} width={560} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {step === 'prompt' ? (
          promptStep
        ) : (
          <>
            <AvatarEditor value={avatar} onChange={setAvatar} variant="modal" />
            <div className="flex gap-2.5">
              <div className="flex flex-1 flex-col gap-[5px]">
                <FieldLabel htmlFor="new-bot-name">{t('newBot.name')}</FieldLabel>
                <TextInput
                  id="new-bot-name"
                  data-autofocus
                  className="h-[38px]"
                  value={name}
                  maxLength={48}
                  required
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('newBot.namePlaceholder')}
                />
              </div>
              <div className="flex flex-1 flex-col gap-[5px]">
                <FieldLabel htmlFor="new-bot-label">{t('newBot.label')}</FieldLabel>
                <TextInput
                  id="new-bot-label"
                  className="h-[38px]"
                  value={label}
                  maxLength={32}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t('newBot.labelPlaceholder')}
                />
              </div>
            </div>
            <div className="flex flex-col gap-[5px]">
              <FieldLabel htmlFor="new-bot-description">{t('newBot.description')}</FieldLabel>
              <TextArea
                id="new-bot-description"
                rows={4}
                className="h-24"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('newBot.descriptionPlaceholder')}
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-fg-secondary">
              <Sparkles size={13} className="shrink-0 text-accent" />
              {t('newBot.hint')}
            </div>
            <div className="flex gap-2.5">
              <div className="flex flex-[332] flex-col gap-[5px]">
                <FieldLabel>{t('newBot.model')}</FieldLabel>
                {selectedModel && options.length > 0 ? (
                  <Select
                    value={selectedModel}
                    label={t('newBot.model')}
                    options={options}
                    onChange={setModel}
                  />
                ) : (
                  <Select
                    value="default"
                    label={t('newBot.model')}
                    disabled
                    options={[{ value: 'default', label: t('newBot.defaultModel') }]}
                    onChange={() => undefined}
                  />
                )}
              </div>
              <div className="flex flex-[170] flex-col gap-[5px]">
                <FieldLabel>{t('newBot.section')}</FieldLabel>
                <Select
                  value={sectionId}
                  label={t('newBot.section')}
                  options={[
                    { value: NONE, label: t('sidebar.sections.none') },
                    ...sections.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                  onChange={setSectionId}
                />
              </div>
            </div>
            {generateFailed && (
              <div className="flex items-center gap-2 text-sm text-danger">
                <span className="flex-1">{t('newBot.generateFailed')}</span>
                <Button size="sm" variant="outline" onClick={applyDescription}>
                  {t('newBot.useDescription')}
                </Button>
              </div>
            )}
            {error && <div className="text-sm text-danger">{t('newBot.failed')}</div>}
            <div className="flex items-center gap-2.5">
              <span className="flex-1 text-sm text-fg-muted">
                {coordinator && t('newBot.orAskInChat', { name: coordinator })}
              </span>
              <Button
                type="submit"
                variant="primary"
                className="h-[34px] px-4"
                disabled={!name.trim() || busy || generating}
              >
                {generating ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  description.trim() && <Sparkles size={14} />
                )}
                {generating
                  ? t('newBot.generating')
                  : description.trim()
                    ? t('newBot.generate')
                    : t('newBot.create')}
              </Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}
