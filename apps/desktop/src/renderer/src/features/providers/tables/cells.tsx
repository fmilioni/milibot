import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { parsePrice, parseTokens, tokenInputText } from '@/features/providers/lib/provider-form'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { Tooltip } from '@/ui/Tooltip'

const CELL_INPUT = `${COMPACT_INPUT} h-[26px] px-1.5 text-right font-mono text-xs tabular-nums disabled:opacity-50`

export function PriceInput({
  value,
  onChange,
  label,
  disabled,
}: {
  value: number | null
  onChange: (value: number | null) => void
  label: string
  disabled: boolean
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  return (
    <input
      aria-label={label}
      disabled={disabled}
      inputMode="decimal"
      value={text}
      placeholder="—"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parsed = parsePrice(text)
        setText(parsed === null ? '' : String(parsed))
        if (parsed !== value) onChange(parsed)
      }}
      className={CELL_INPUT}
    />
  )
}

/** Token count typed as `128k` / `1M`; shown compact, and the exact value is kept unless edited. */
export function TokenInput({
  value,
  onChange,
  label,
  hint,
  disabled,
}: {
  value: number | null
  onChange: (value: number | null) => void
  label: string
  hint: string
  disabled: boolean
}) {
  const { i18n } = useTranslation()
  const [text, setText] = useState(tokenInputText(value))
  const exact = value ? ` · ${new Intl.NumberFormat(i18n.language).format(value)}` : ''
  return (
    <Tooltip content={`${hint}${exact}`}>
      <input
        aria-label={label}
        disabled={disabled}
        inputMode="numeric"
        value={text}
        placeholder="—"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === tokenInputText(value)) return
          const parsed = parseTokens(text)
          setText(tokenInputText(parsed))
          if (parsed !== value) onChange(parsed)
        }}
        className={CELL_INPUT}
      />
    </Tooltip>
  )
}

export function RemoveRowButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-label={t('settings.providers.table.remove', { name })}
      onClick={onRemove}
      className="focus-ring flex size-5 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
    >
      <X size={12} />
    </button>
  )
}

export type SetRows<T> = (update: (rows: T[]) => T[]) => void

export function patchRow<T extends { key: string }>(setRows: SetRows<T>, key: string, patch: Partial<T>) {
  setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)))
}
