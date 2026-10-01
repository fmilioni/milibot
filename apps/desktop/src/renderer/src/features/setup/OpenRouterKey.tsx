import { CircleAlert, CircleCheck, KeyRound, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { looksLikeOpenRouterKey, maskKey, type ProviderStepState } from '@/features/setup/lib/setup'
import { formatUsd } from '@/lib/format'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { checkOpenRouterKey } from './api'
import type { StepPatch } from './ProvidersStep'

function KeyStatusIcon({ state }: { state: ProviderStepState['openRouterCheck'] }) {
  const { t, i18n } = useTranslation()
  switch (state.status) {
    case 'checking':
      return (
        <Tooltip content={t('setup.providers.openRouter.checking')}>
          <Spinner size={13} className="text-fg-muted" label={t('setup.providers.openRouter.checking')} />
        </Tooltip>
      )
    case 'valid':
      return (
        <Tooltip
          content={
            state.creditUsd !== null
              ? t('setup.providers.openRouter.credit', { amount: formatUsd(state.creditUsd, i18n.language) })
              : t('setup.providers.openRouter.valid')
          }
        >
          <CircleCheck
            size={13}
            className="text-success"
            aria-label={t('setup.providers.openRouter.valid')}
          />
        </Tooltip>
      )
    case 'saved':
      return (
        <Tooltip content={t('setup.providers.openRouter.saved')}>
          <CircleCheck
            size={13}
            className="text-success"
            aria-label={t('setup.providers.openRouter.saved')}
          />
        </Tooltip>
      )
    case 'invalid':
    case 'unreachable':
      return (
        <Tooltip content={t(`setup.providers.openRouter.${state.status}`)}>
          <CircleAlert
            size={13}
            className="text-danger"
            aria-label={t(`setup.providers.openRouter.${state.status}`)}
          />
        </Tooltip>
      )
    default:
      return null
  }
}

export function OpenRouterKey({
  workspaceId,
  state,
  savedKey,
  onChange,
}: {
  workspaceId: string
  state: ProviderStepState
  savedKey: boolean
  onChange: (patch: StepPatch) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [focused, setFocused] = useState(false)
  const key = state.openRouterKey
  const check = state.openRouterCheck
  useEffect(() => {
    let stale = false
    const trimmed = key.trim()
    if (!trimmed) return
    if (!looksLikeOpenRouterKey(trimmed)) {
      onChange({ openRouterCheck: { status: 'invalid' } })
      return
    }
    onChange({ openRouterCheck: { status: 'checking' } })
    const timer = setTimeout(() => {
      void checkOpenRouterKey(workspaceId, trimmed)
        .then((result) => {
          if (stale) return
          onChange({
            openRouterCheck: result.valid
              ? { status: 'valid', creditUsd: result.creditUsd }
              : { status: result.error === 'unreachable' ? 'unreachable' : 'invalid' },
          })
        })
        .catch(() => {
          if (!stale) onChange({ openRouterCheck: { status: 'unreachable' } })
        })
    }, 500)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // onChange is a fresh closure every render; the key alone drives the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId])

  if (check.status === 'saved' && !editing) {
    return (
      <div className="flex h-[27px] w-[200px] items-center gap-2 rounded-[7px] border border-border bg-surface-2 px-2">
        <KeyRound size={12} className="shrink-0 text-fg-muted" />
        <span className="flex-1 truncate font-mono text-xs text-fg-secondary">sk-or-••••</span>
        <KeyStatusIcon state={check} />
        <Tooltip content={t('setup.providers.openRouter.replace')}>
          <button
            type="button"
            aria-label={t('setup.providers.openRouter.replace')}
            onClick={() => setEditing(true)}
            className="focus-ring rounded text-fg-muted hover:text-fg"
          >
            <Pencil size={11} />
          </button>
        </Tooltip>
      </div>
    )
  }

  const showMasked = !focused && check.status === 'valid'
  return (
    <label className="flex h-[27px] w-[200px] items-center gap-2 rounded-[7px] border border-border bg-surface-2 px-2 focus-within:border-accent">
      <KeyRound size={12} className="shrink-0 text-fg-muted" />
      <input
        aria-label={t('setup.providers.openRouter.keyLabel')}
        className="selectable min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-fg-muted"
        type={showMasked ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('setup.providers.openRouter.keyPlaceholder')}
        value={showMasked ? maskKey(key) : key}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) =>
          onChange({
            openRouterKey: e.target.value,
            ...(e.target.value.trim()
              ? {}
              : { openRouterCheck: savedKey ? { status: 'saved' } : { status: 'empty' } }),
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Escape' && savedKey) {
            onChange({ openRouterKey: '', openRouterCheck: { status: 'saved' } })
            setEditing(false)
          }
        }}
      />
      <KeyStatusIcon state={check} />
    </label>
  )
}
