import type { AnswerSecretBody, Bot, SecretRequestPayload, SecretScope } from '@milibot/shared'
import {
  CircleCheck,
  CircleSlash,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Settings2,
  ShieldCheck,
  TimerOff,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Select } from '@/ui/Select'
import { Tooltip } from '@/ui/Tooltip'

/**
 * `request_secret` card. The value typed here lives only in this component's state: it goes straight
 * to the daemon on "Send" and is cleared right after, never reaching the store, the chat or logs.
 */
export function SecretRequestCard({
  payload,
  bot,
  onAnswer,
  onDecline,
  onManage,
}: {
  payload: SecretRequestPayload
  bot: Bot | undefined
  onAnswer: (body: AnswerSecretBody) => Promise<void>
  onDecline: () => Promise<void>
  onManage: () => void
}) {
  if (payload.status === 'pending')
    return <PendingSecret payload={payload} bot={bot} onAnswer={onAnswer} onDecline={onDecline} />
  return <ResolvedSecret payload={payload} name={bot?.name ?? '…'} onManage={onManage} />
}

function PendingSecret({
  payload,
  bot,
  onAnswer,
  onDecline,
}: {
  payload: SecretRequestPayload
  bot: Bot | undefined
  onAnswer: (body: AnswerSecretBody) => Promise<void>
  onDecline: () => Promise<void>
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const name = bot?.name ?? '…'
  const kind = payload.asEnv ? 'env' : 'password'
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [remember, setRemember] = useState(true)
  const [scope, setScope] = useState<SecretScope>(payload.asEnv ? 'all' : 'bot')
  const [busy, setBusy] = useState(false)

  const send = () => {
    if (!value || busy) return
    setBusy(true)
    const body: AnswerSecretBody = { value, remember: payload.asEnv || remember, scope }
    void onAnswer(body).finally(() => {
      setValue('')
      setVisible(false)
      setBusy(false)
    })
  }
  const decline = () => {
    if (busy) return
    setBusy(true)
    void onDecline().finally(() => setBusy(false))
  }

  const scopeSelect = (
    <div className="w-fit shrink-0">
      <Select<SecretScope>
        size="sm"
        label={t('chat.secretRequest.scope')}
        value={scope}
        onChange={setScope}
        disabled={busy}
        menuAlign="end"
        options={[
          { value: 'bot', label: t('chat.secretRequest.scopeBot', { name }) },
          { value: 'all', label: t('chat.secretRequest.scopeAll') },
        ]}
        renderValue={(option) => (
          <>
            <span className="text-xs text-fg-muted">{t('chat.secretRequest.scopePrefix')}</span>
            <span className="truncate font-semibold">{option?.label}</span>
          </>
        )}
      />
    </div>
  )
  const actions = (
    <>
      <Button size="sm" disabled={busy} onClick={decline}>
        {t('chat.secretRequest.decline')}
      </Button>
      <Button size="sm" variant="primary" disabled={!value || busy} onClick={send}>
        {t('chat.secretRequest.send')}
      </Button>
    </>
  )

  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface-2 p-4 focus-within:border-accent"
      data-secret-request={payload.requestId}
    >
      <div className="flex items-center gap-2">
        {bot && <BotAvatar avatar={bot.avatar} size={18} animated={false} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
          {t(`chat.secretRequest.title_${kind}`, { name })}
        </span>
        <Tooltip content={t('chat.secretRequest.safeHint')}>
          <span className="flex shrink-0 items-center gap-[5px] rounded-full bg-success-soft px-2 py-[3px] text-xs font-semibold text-success">
            <ShieldCheck size={12} aria-hidden />
            {t('chat.secretRequest.safe')}
          </span>
        </Tooltip>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="selectable text-md font-semibold break-words text-fg">{payload.label}</span>
          {payload.asEnv && (
            <span className="selectable rounded-[5px] bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-fg">
              {payload.name}
            </span>
          )}
        </div>
        {payload.reason && (
          <p className="selectable text-sm leading-[17px] text-fg-secondary">{payload.reason}</p>
        )}
      </div>

      <div className="flex h-[38px] items-center gap-2 rounded-lg border border-border bg-surface px-3 group/pw focus-within:border-accent">
        <KeyRound
          size={14}
          className="shrink-0 text-fg-muted group-focus-within/pw:text-accent"
          aria-hidden
        />
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={t('chat.secretRequest.valueLabel', { label: payload.label })}
          placeholder={t(`chat.secretRequest.placeholder_${kind}`)}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          className={cn(
            'selectable min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:font-sans placeholder:text-base placeholder:text-fg-muted',
            visible || !value ? 'text-base' : 'font-mono text-md tracking-[0.12em]',
          )}
        />
        <Tooltip content={visible ? t('chat.secretRequest.hide') : t('chat.secretRequest.show')}>
          <button
            type="button"
            aria-label={visible ? t('chat.secretRequest.hide') : t('chat.secretRequest.show')}
            aria-controls={inputId}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            className="focus-ring flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:text-fg"
          >
            {visible ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </Tooltip>
      </div>

      {payload.asEnv ? (
        <>
          <div className="flex items-center gap-2">
            <Settings2 size={12} className="shrink-0 text-fg-muted" aria-hidden />
            <p className="min-w-0 flex-1 text-xs leading-[15px] text-fg-secondary">
              {t('chat.secretRequest.envNote', { secret: payload.name })}
            </p>
            {scopeSelect}
          </div>
          <div className="flex justify-end gap-2">{actions}</div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="radiogroup" aria-label={t('chat.secretRequest.duration')} className="flex gap-4">
              <Radio checked={remember} disabled={busy} onSelect={() => setRemember(true)}>
                {t('chat.secretRequest.remember')}
              </Radio>
              <Radio checked={!remember} disabled={busy} onSelect={() => setRemember(false)}>
                {t('chat.secretRequest.once')}
              </Radio>
            </div>
            <span className="flex-1" />
            {scopeSelect}
          </div>
          <div className="flex items-center gap-2">
            <Lock size={12} className="shrink-0 text-fg-muted" aria-hidden />
            <p className="min-w-0 flex-1 text-xs leading-[15px] text-fg-muted">
              {t(remember ? 'chat.secretRequest.hintRemember' : 'chat.secretRequest.hintOnce', { name })}
            </p>
            {actions}
          </div>
        </>
      )}
    </div>
  )
}

function Radio({
  checked,
  disabled,
  onSelect,
  children,
}: {
  checked: boolean
  disabled: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className="focus-ring flex items-center gap-1.5 rounded text-sm disabled:opacity-60"
    >
      <span
        className={cn(
          'size-3.5 shrink-0 rounded-full bg-surface',
          checked ? 'border-4 border-accent' : 'border border-border',
        )}
        aria-hidden
      />
      <span className={checked ? 'text-fg' : 'text-fg-secondary'}>{children}</span>
    </button>
  )
}

function ResolvedSecret({
  payload,
  name,
  onManage,
}: {
  payload: SecretRequestPayload
  name: string
  onManage: () => void
}) {
  const { t } = useTranslation()
  const kind = payload.asEnv ? 'env' : 'password'
  const scope = payload.scope ?? (payload.asEnv ? 'all' : 'bot')
  if (payload.status === 'answered') {
    const kept = payload.asEnv || payload.remember !== false
    const title = payload.asEnv
      ? t('chat.secretRequest.sentEnv', { secret: payload.name })
      : t('chat.secretRequest.sentTitle', { name, label: payload.label })
    const sub = payload.asEnv
      ? t(`chat.secretRequest.sentEnvSub_${scope}`, { name })
      : kept
        ? t(`chat.secretRequest.sentRemember_${scope}`, { secret: payload.name, name })
        : t('chat.secretRequest.sentOnce')
    return (
      <ResolvedRow
        tone="success"
        icon={<CircleCheck size={14} className="text-success" />}
        title={title}
        sub={sub}
        action={
          kept ? (
            <button
              type="button"
              onClick={onManage}
              className="focus-ring shrink-0 rounded text-sm text-accent hover:underline"
            >
              {t('chat.secretRequest.manage')}
            </button>
          ) : null
        }
      />
    )
  }
  if (payload.status === 'declined') {
    return (
      <ResolvedRow
        icon={<CircleSlash size={14} className="text-fg-muted" />}
        title={t(`chat.secretRequest.declined_${kind}`, { name })}
        sub={payload.label}
      />
    )
  }
  return (
    <ResolvedRow
      icon={<TimerOff size={14} className="text-fg-muted" />}
      title={t(`chat.secretRequest.expired_${kind}`)}
      sub={`${t(`chat.secretRequest.expiredReason.${payload.expiredReason ?? 'stopped'}`, { name })} · ${payload.label}`}
    />
  )
}

function ResolvedRow({
  tone = 'muted',
  icon,
  title,
  sub,
  action,
}: {
  tone?: 'success' | 'muted'
  icon: ReactNode
  title: string
  sub: string
  action?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] px-3 py-2.5',
        tone === 'success' ? 'bg-success-soft' : 'bg-surface-3',
      )}
    >
      <span className="shrink-0" aria-hidden>
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-base font-semibold', tone === 'success' ? 'text-fg' : 'text-fg-secondary')}>
          {title}
        </span>
        <span className="text-sm leading-[15px] text-fg-secondary">{sub}</span>
      </div>
      {action}
    </div>
  )
}
