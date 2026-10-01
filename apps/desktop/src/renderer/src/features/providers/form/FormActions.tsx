import type { ConnectionTest } from '@milibot/shared'
import { Check, Minus, X, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { type Tone, TONE_SOFT } from '@/lib/tone'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

export type TestState = { status: 'idle' } | { status: 'testing' } | ({ status: 'done' } & ConnectionTest)

const CAPABILITY_TONE: Record<'ok' | 'no' | 'unknown', Tone> = {
  ok: 'success',
  no: 'danger',
  unknown: 'muted',
}

function CapabilityChip({ state, children }: { state: 'ok' | 'no' | 'unknown'; children: string }) {
  const Icon = state === 'ok' ? Check : state === 'no' ? X : Minus
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 rounded-md px-2 text-xs ${TONE_SOFT[CAPABILITY_TONE[state]]}`}
    >
      <Icon size={11} aria-hidden />
      {children}
    </span>
  )
}

/** Connection test with what it found, and the save button. */
export function FormActions({
  test,
  enabledModels,
  urlValid,
  saving,
  canSave,
  onTest,
  onSave,
}: {
  test: TestState
  /** Enabled chat models; null hides the count (Anthropic has no table). */
  enabledModels: number | null
  urlValid: boolean
  saving: boolean
  canSave: boolean
  onTest: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const done = test.status === 'done' ? test : null
  return (
    <>
      {done && !done.ok && done.error && <p className="selectable text-sm text-danger">{done.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={test.status === 'testing' || !urlValid} onClick={onTest}>
          {test.status === 'testing' ? <Spinner size={13} /> : <Zap size={13} />}
          {t('settings.providers.form.test')}
        </Button>
        {enabledModels !== null && (
          <CapabilityChip state={enabledModels > 0 ? 'ok' : 'unknown'}>
            {t('settings.providers.form.models', { count: enabledModels })}
          </CapabilityChip>
        )}
        {done && (
          <>
            <CapabilityChip state={done.ok ? 'ok' : 'no'}>
              {done.ok
                ? t('settings.providers.form.connected', { ms: done.latencyMs ?? 0 })
                : t('settings.providers.form.failed')}
            </CapabilityChip>
            {done.ok && (
              <>
                <CapabilityChip state={done.supportsTools ? 'ok' : 'no'}>
                  {t('settings.providers.form.usesTools')}
                </CapabilityChip>
                <CapabilityChip state={done.supportsVision ? 'ok' : 'no'}>
                  {t('settings.providers.form.seesImages')}
                </CapabilityChip>
              </>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={saving || !canSave} onClick={onSave}>
            {saving && <Spinner size={13} />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </>
  )
}
