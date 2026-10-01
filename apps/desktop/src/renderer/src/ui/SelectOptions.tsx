import { Check } from 'lucide-react'

import { cn } from '@/lib/cn'
import type { SelectGroupInfo, SelectOption } from '@/lib/select'

interface OptionProps {
  option: SelectOption<string>
  id: string
  selected: boolean
  highlighted: boolean
  onHover: () => void
  onPick: () => void
}

/** An option with a check mark on the right when picked. */
export function PlainOption({ option, id, selected, highlighted, onHover, onPick }: OptionProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      onPointerMove={onHover}
      onClick={onPick}
      className={cn(
        'flex min-h-[30px] cursor-default items-center gap-[9px] rounded-md px-[9px] py-1.5',
        highlighted && !option.disabled && 'bg-surface-3',
        option.disabled && 'opacity-45',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-base leading-4 text-fg">{option.label}</span>
        {option.description && (
          <span className="truncate text-xs leading-[14px] text-fg-muted">{option.description}</span>
        )}
      </div>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {selected && <Check size={14} className="text-accent" aria-hidden />}
      </span>
    </div>
  )
}

/** A rich list option (`groups`): a radio, badge and right column instead of the check mark. */
export function RichOption({ option, id, selected, highlighted, onHover, onPick }: OptionProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      onPointerMove={onHover}
      onClick={onPick}
      className={cn(
        'flex min-h-[41px] cursor-default items-center gap-2.5 rounded-[7px] py-1.5 pr-2.5 pl-[22px]',
        selected ? 'bg-accent/8' : highlighted ? 'bg-surface-3' : '',
        option.disabled && 'opacity-45',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 rounded-full border bg-surface',
          selected ? 'border-[4px] border-accent' : 'border-border',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-sm leading-[15px] text-fg',
              selected ? 'font-semibold' : 'font-medium',
            )}
          >
            {option.label}
          </span>
          {option.badge && (
            <span className="shrink-0 rounded-[5px] bg-accent px-1.5 text-2xs leading-[14px] font-semibold text-on-accent">
              {option.badge}
            </span>
          )}
        </span>
        {option.description && (
          <span className="truncate text-xs leading-[13px] text-fg-muted">{option.description}</span>
        )}
      </div>
      {(option.meta || option.metaDetail) && (
        <div className="flex shrink-0 flex-col items-end gap-px text-right">
          {option.meta && (
            <span className="text-xs leading-[13px] font-semibold text-fg-secondary">{option.meta}</span>
          )}
          {option.metaDetail && (
            <span className="text-2xs leading-[12px] text-fg-muted">{option.metaDetail}</span>
          )}
        </div>
      )}
    </div>
  )
}

export function GroupHeader({ info, id }: { info: SelectGroupInfo; id: string }) {
  return (
    <div id={id} className="flex flex-col gap-0.5 px-2.5 pt-0.5 pb-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-base leading-4 font-bold text-fg">{info.title}</span>
        {info.vendor && <span className="shrink-0 text-xs text-fg-muted">{info.vendor}</span>}
        {info.tag && (
          <span
            className={cn(
              'ml-auto flex shrink-0 items-center gap-1 rounded-[5px] px-[7px] py-0.5 text-2xs leading-3 font-semibold',
              info.tag.tone === 'success' ? 'bg-success/10 text-success' : 'bg-surface-3 text-fg-secondary',
            )}
          >
            {info.tag.icon}
            {info.tag.label}
          </span>
        )}
      </div>
      {info.description && <span className="text-xs leading-[13px] text-fg-muted">{info.description}</span>}
    </div>
  )
}
