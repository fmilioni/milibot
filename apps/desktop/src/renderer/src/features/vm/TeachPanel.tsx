import type { Bot, ProcedureScope } from '@milibot/shared'
import { Check, LoaderCircle, Pause, Play, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { useNow } from '@/hooks/use-now'
import { appLanguage } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatElapsed } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { FieldLabel, TextInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

import { recordingElapsed, type TeachSession, useTeachStore } from './teach-store'

export function RecordingBar({ bot, session }: { bot: Bot; session: TeachSession }) {
  const { t } = useTranslation()
  const dispatch = useTeachStore((s) => s.dispatch)
  const paused = session.recording.paused
  const now = useNow(500, !paused)
  const steps = session.recording.steps.length
  const [finishing, setFinishing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  return (
    <div className="flex shrink-0 items-center gap-2.5 rounded-[10px] border border-border bg-surface-2 py-2 pr-2 pl-3">
      <span
        className={cn(
          'size-[9px] shrink-0 rounded-full bg-danger',
          paused ? 'opacity-40' : 'animate-pulse motion-reduce:animate-none',
        )}
      />
      <span className="font-mono text-base font-semibold text-fg tabular-nums">
        {formatElapsed(recordingElapsed(session, now))}
      </span>
      <span className="truncate text-base text-fg-secondary">{t('teach.bar.steps', { count: steps })}</span>
      <span className="flex-1" />
      <Tooltip content={t('teach.bar.discard')}>
        <button
          type="button"
          onClick={() => (steps > 0 ? setDiscarding(true) : void useTeachStore.getState().discard())}
          aria-label={t('teach.bar.discard')}
          className="focus-ring flex size-[27px] items-center justify-center rounded-[7px] text-fg-muted hover:bg-surface-3 hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </Tooltip>
      <Button size="sm" onClick={() => dispatch({ type: paused ? 'resume' : 'pause' })}>
        {paused ? <Play size={13} /> : <Pause size={13} />}
        {paused ? t('teach.bar.resume') : t('teach.bar.pause')}
      </Button>
      <Button size="sm" disabled={steps === 0} onClick={() => dispatch({ type: 'undo' })}>
        <Undo2 size={13} />
        {t('teach.bar.undo')}
      </Button>
      <Button size="sm" variant="primary" disabled={steps === 0} onClick={() => setFinishing(true)}>
        <Check size={13} />
        {t('teach.bar.finish')}
      </Button>
      {finishing && <FinishDialog bot={bot} session={session} onClose={() => setFinishing(false)} />}
      {discarding && (
        <Modal
          title={t('teach.discard.title')}
          description={t('teach.discard.body', { count: steps })}
          width={380}
          onClose={() => setDiscarding(false)}
        >
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setDiscarding(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscarding(false)
                void useTeachStore.getState().discard()
              }}
            >
              {t('teach.discard.confirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function FinishDialog({ bot, session, onClose }: { bot: Bot; session: TeachSession; onClose: () => void }) {
  const { t } = useTranslation()
  const finish = useTeachStore((s) => s.finish)
  const showToast = useAppStore((s) => s.showToast)
  const [name, setName] = useState(session.name)
  const [scope, setScope] = useState<ProcedureScope>('bot')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await finish({
        name: name.trim(),
        scope,
        language: appLanguage(),
      })
      onClose()
    } catch {
      showToast('error')
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('teach.finish.title')}
      description={t('teach.finish.description', { name: bot.name, count: session.recording.steps.length })}
      width={440}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel>{t('teach.finish.name')}</FieldLabel>
          <TextInput
            data-autofocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('teach.start.namePlaceholder')}
          />
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <FieldLabel>{t('teach.finish.scope')}</FieldLabel>
          <div className="flex gap-2">
            {(['bot', 'global'] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={scope === key}
                onClick={() => setScope(key)}
                className={cn(
                  'focus-ring flex-1 rounded-lg border px-3 py-2 text-base',
                  scope === key
                    ? 'border-accent bg-accent-soft font-semibold text-accent'
                    : 'border-border bg-surface-2 text-fg-secondary',
                )}
              >
                {key === 'bot'
                  ? t('teach.finish.scopeBot', { name: bot.name })
                  : t('teach.finish.scopeGlobal')}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            {busy && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />}
            {busy ? t('teach.finish.saving') : t('teach.finish.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** "Analyst is writing the procedure…" while the model writes up a recording. */
export function GeneratingProcedures({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const generating = useTeachStore((s) => s.generating)
  const mine = Object.entries(generating).filter(([, g]) => g.botId === bot.id)
  if (mine.length === 0) return null
  return (
    <div className="flex shrink-0 flex-col gap-1">
      {mine.map(([id, g]) => (
        <div key={id} className="flex items-center gap-2 text-sm text-fg-secondary">
          <LoaderCircle size={13} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />
          {t('teach.generating', { name: bot.name, procedure: g.name })}
        </div>
      ))}
    </div>
  )
}
