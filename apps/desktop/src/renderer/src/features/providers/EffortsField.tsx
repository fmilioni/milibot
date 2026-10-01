import { isStandardEffort, normalizeEffort, REASONING_EFFORTS, type ReasoningEffort } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { effortLabel, MODEL_DEFAULT, sortEfforts } from '@/features/providers/lib/models'
import { cn } from '@/lib/cn'
import { computeDropdownPosition } from '@/lib/select'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'
import { Select } from '@/ui/Select'

/** Summary of the levels a model accepts: `—` unknown, `none`, one level, `first–last`, then custom ones. */
export function effortsSummary(t: TFunction, efforts: readonly ReasoningEffort[] | null): string {
  if (efforts === null) return '—'
  const standard = REASONING_EFFORTS.filter((level) => efforts.includes(level))
  const custom = sortEfforts(efforts).filter((level) => !isStandardEffort(level))
  const first = standard[0]
  const last = standard.at(-1)
  const range =
    !first || !last
      ? []
      : [
          first === last
            ? effortLabel(t, first, 'short')
            : `${effortLabel(t, first, 'short')}–${effortLabel(t, last, 'short')}`,
        ]
  const parts = [...range, ...custom]
  return parts.length ? parts.join(', ') : t('settings.providers.efforts.none')
}

type Suggestion = { kind: 'level' | 'custom'; value: ReasoningEffort } | { kind: 'invalid' }

/**
 * Which efforts the model accepts (standard levels from the list, or any value the server takes, typed in)
 * and which one it uses by default.
 */
export function EffortsField({
  efforts,
  defaultEffort,
  modelId,
  disabled,
  onChange,
}: {
  efforts: ReasoningEffort[] | null
  defaultEffort: ReasoningEffort | null
  modelId: string
  disabled: boolean
  onChange: (patch: { efforts: ReasoningEffort[] | null; defaultEffort: ReasoningEffort | null }) => void
}) {
  const { t } = useTranslation()
  const baseId = useId()
  const listId = `${baseId}-list`
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const levels = efforts ?? []
  const has = (level: string) => levels.some((l) => l.toLowerCase() === level.toLowerCase())
  const label = `${t('settings.providers.table.groups.efforts')} · ${modelId}`

  const typed = text.trim()
  const normalized = typed ? normalizeEffort(typed) : null
  const query = typed.toLowerCase()
  const matching = REASONING_EFFORTS.filter(
    (level) =>
      !has(level) &&
      (!query || level.startsWith(query) || effortLabel(t, level).toLowerCase().startsWith(query)),
  )
  const custom = normalized && !has(normalized) && !isStandardEffort(normalized) ? normalized : null
  const suggestions: Suggestion[] = [
    ...(typed && normalized === null ? [{ kind: 'invalid' as const }] : []),
    ...matching.map((value) => ({ kind: 'level' as const, value })),
    ...(custom ? [{ kind: 'custom' as const, value: custom }] : []),
  ]
  const showList = open && !disabled && suggestions.length > 0

  const set = (next: ReasoningEffort[]) => {
    const sorted = sortEfforts(next)
    onChange({
      efforts: sorted,
      defaultEffort: defaultEffort && sorted.includes(defaultEffort) ? defaultEffort : null,
    })
  }
  const add = (level: ReasoningEffort) => {
    if (!has(level)) set([...levels, level])
    setText('')
    setActive(0)
  }
  const remove = (level: ReasoningEffort) => set(levels.filter((l) => l !== level))
  const pick = (suggestion: Suggestion | undefined) => {
    if (suggestion && suggestion.kind !== 'invalid') add(suggestion.value)
  }

  const { ref: listRef, position } = useAnchoredPosition((list, viewport) => {
    const rect = boxRef.current?.getBoundingClientRect() ?? new DOMRect()
    return computeDropdownPosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: list.offsetWidth, height: list.scrollHeight },
      viewport,
    )
  }, showList)

  useEffect(() => {
    if (!showList) return
    const close = () => setOpen(false)
    const onScroll = (event: Event) => {
      if (!listRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [showList, listRef])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const key = event.key
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setOpen(true)
      setActive((i) => Math.max(0, Math.min(suggestions.length - 1, i + (key === 'ArrowDown' ? 1 : -1))))
    } else if (key === 'Enter' || key === ',') {
      if (!typed && key === ',') return
      event.preventDefault()
      if (open && suggestions[active]) pick(suggestions[active])
      else if (normalized) add(normalized)
    } else if (key === 'Backspace' && !text && levels.length) {
      const last = levels.at(-1)
      if (last) remove(last)
    } else if (key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  const note =
    efforts === null
      ? t('settings.providers.efforts.unknownState')
      : efforts.length === 0
        ? t('settings.providers.efforts.hint')
        : null

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex max-w-full min-w-0 flex-col gap-1">
          <span className="text-xs text-fg-muted">{t('settings.providers.efforts.levels')}</span>
          <div
            ref={boxRef}
            onMouseDown={(event) => {
              if (event.target !== inputRef.current) event.preventDefault()
              inputRef.current?.focus()
            }}
            className={cn(
              'flex min-h-[26px] w-[400px] max-w-full min-w-0 flex-wrap items-center gap-1 rounded-[6px] border bg-surface px-1 py-[2px]',
              disabled ? 'opacity-50' : 'cursor-text',
              showList ? 'border-accent' : 'border-border focus-within:border-accent',
            )}
          >
            {levels.map((level) => (
              <span
                key={level}
                className="inline-flex h-[20px] items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-[7px] text-xs text-fg-secondary"
              >
                {effortLabel(t, level)}
                {!disabled && (
                  <button
                    type="button"
                    aria-label={t('settings.providers.efforts.remove', { level: effortLabel(t, level) })}
                    onClick={() => remove(level)}
                    className="focus-ring flex size-4 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
                  >
                    <X size={10} aria-hidden />
                  </button>
                )}
              </span>
            ))}
            <input
              ref={inputRef}
              role="combobox"
              aria-label={label}
              aria-expanded={showList}
              aria-controls={showList ? listId : undefined}
              aria-activedescendant={showList ? `${baseId}-opt-${active}` : undefined}
              aria-autocomplete="list"
              disabled={disabled}
              value={text}
              placeholder={levels.length ? '' : t('settings.providers.efforts.placeholder')}
              onChange={(event) => {
                setText(event.target.value)
                setActive(0)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => {
                setOpen(false)
                if (custom && !matching.length) add(custom)
                else setText('')
              }}
              onKeyDown={onKeyDown}
              className="selectable h-[20px] min-w-[32px] flex-1 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-muted"
            />
          </div>
        </div>
        {!!efforts?.length && (
          <div className="flex w-[130px] flex-col gap-1">
            <span className="text-xs text-fg-muted">{t('settings.providers.efforts.default')}</span>
            <div>
              <Select
                size="sm"
                label={`${t('settings.providers.efforts.default')} · ${modelId}`}
                disabled={disabled}
                value={defaultEffort ?? MODEL_DEFAULT}
                options={[
                  { value: MODEL_DEFAULT, label: t('settings.providers.efforts.providerDefault') },
                  ...efforts.map((level) => ({ value: level, label: effortLabel(t, level) })),
                ]}
                onChange={(value) =>
                  onChange({ efforts, defaultEffort: value === MODEL_DEFAULT ? null : value })
                }
              />
            </div>
          </div>
        )}
      </div>
      {(note || efforts !== null) && (
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
          {note}
          {efforts !== null && !disabled && (
            <button
              type="button"
              onClick={() => onChange({ efforts: null, defaultEffort: null })}
              className="focus-ring w-fit rounded text-accent hover:underline"
            >
              {t('settings.providers.efforts.unknown')}
            </button>
          )}
        </div>
      )}
      {showList && (
        <FloatingPortal
          ref={listRef}
          position={position}
          id={listId}
          role="listbox"
          aria-label={label}
          data-menu
          onMouseDown={(event) => event.preventDefault()}
          className="scroll-slim z-dropdown flex w-max max-w-[340px] min-w-[200px] flex-col gap-px overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-surface-2 p-[5px] shadow-[0_10px_30px_rgba(0,0,0,0.18)] outline-none dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.kind === 'invalid' ? 'invalid' : `${suggestion.kind}-${suggestion.value}`}
              id={`${baseId}-opt-${index}`}
              role="option"
              aria-selected={index === active}
              aria-disabled={suggestion.kind === 'invalid' || undefined}
              onPointerMove={() => active !== index && setActive(index)}
              onClick={() => pick(suggestion)}
              className={cn(
                'flex min-h-[30px] cursor-default items-center gap-[9px] rounded-md px-[9px] py-1.5 text-base leading-4',
                index === active && suggestion.kind !== 'invalid' && 'bg-surface-3',
                suggestion.kind === 'invalid' ? 'text-fg-muted' : 'text-fg',
              )}
            >
              {suggestion.kind === 'custom' && (
                <Plus size={12} aria-hidden className="shrink-0 text-accent" />
              )}
              <span className="truncate">
                {suggestion.kind === 'invalid'
                  ? t('settings.providers.efforts.invalid')
                  : suggestion.kind === 'custom'
                    ? t('settings.providers.efforts.add', { value: suggestion.value })
                    : effortLabel(t, suggestion.value)}
              </span>
            </div>
          ))}
        </FloatingPortal>
      )}
    </div>
  )
}
