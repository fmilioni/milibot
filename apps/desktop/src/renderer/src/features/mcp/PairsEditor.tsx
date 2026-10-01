import { Lock, LockOpen, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

import { type Pair, pair } from './lib/pairs'

export const fieldInput =
  'selectable h-[30px] w-full rounded-[7px] border border-border bg-surface px-2.5 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent'

/** Name = value rows (env or headers), each value optionally secret. */
export function PairsEditor({
  id,
  pairs,
  onChange,
  namePlaceholder,
  addLabel,
}: {
  id: string
  pairs: Pair[]
  onChange: (pairs: Pair[]) => void
  namePlaceholder: string
  addLabel: string
}) {
  const { t } = useTranslation()
  const set = (key: number, patch: Partial<Pair>) =>
    onChange(pairs.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((p, index) => (
        <div key={p.key} className="flex items-center gap-1.5">
          <input
            id={index === 0 ? id : undefined}
            aria-label={namePlaceholder}
            className={`${fieldInput} w-[34%] max-w-[240px] shrink-0 font-mono`}
            placeholder={namePlaceholder}
            value={p.name}
            spellCheck={false}
            onChange={(e) => set(p.key, { name: e.target.value })}
          />
          <span className="text-sm text-fg-muted" aria-hidden>
            =
          </span>
          <input
            aria-label={p.name ? `${p.name}` : t('mcp.form.valuePlaceholder')}
            className={`${fieldInput} min-w-0 flex-1 font-mono`}
            type={p.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={p.saved ? t('mcp.form.savedSecret') : t('mcp.form.valuePlaceholder')}
            value={p.value}
            onChange={(e) => set(p.key, { value: e.target.value })}
          />
          <Tooltip content={p.secret ? t('mcp.form.secretOn') : t('mcp.form.secretOff')}>
            <button
              type="button"
              role="switch"
              aria-checked={p.secret}
              aria-label={t('mcp.form.secretOff')}
              onClick={() => set(p.key, { secret: !p.secret })}
              className={cn(
                'focus-ring flex size-[30px] shrink-0 items-center justify-center rounded-[7px]',
                p.secret ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-3',
              )}
            >
              {p.secret ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
          </Tooltip>
          <button
            type="button"
            aria-label={t('mcp.form.remove', { name: p.name || namePlaceholder })}
            onClick={() => onChange(pairs.filter((x) => x.key !== p.key))}
            className="focus-ring flex size-[30px] shrink-0 items-center justify-center rounded-[7px] text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, pair()])}
        className="focus-ring flex w-fit items-center gap-1 rounded text-sm font-medium text-accent hover:underline"
      >
        <Plus size={12} />
        {addLabel}
      </button>
    </div>
  )
}
