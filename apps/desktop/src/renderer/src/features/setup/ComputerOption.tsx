import type { ComputerKind } from '@milibot/shared'
import { Cloud, Monitor, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

const ICONS: Record<ComputerKind, typeof Monitor> = { vm: Monitor, none: Cloud }

/**
 * One choice of where the bots work, as a radio card (wrap the cards in a `role="radiogroup"`). `children`
 * sit inside the card below its button, so they can hold their own controls (the VM size).
 */
export function ComputerOption({
  kind,
  description,
  selected,
  warning,
  onSelect,
  children,
}: {
  kind: ComputerKind
  description: string
  selected: boolean
  /** A short caution shown under the description ("Slow on this computer"). */
  warning?: string | null
  onSelect: () => void
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const Icon = ICONS[kind]

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-3 rounded-[10px] border transition-colors',
        selected ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-3/40',
        Boolean(children) && selected && 'pb-3.5',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="focus-ring flex w-full items-start gap-3 rounded-[10px] px-4 pt-3.5 text-left [&:last-child]:pb-3.5"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0 rounded-full border',
            selected ? 'border-[5px] border-accent bg-bg' : 'border-[1.5px] border-fg-muted',
          )}
        />
        <Icon
          size={17}
          aria-hidden
          className={cn('shrink-0', selected ? 'text-accent' : 'text-fg-secondary')}
        />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-md leading-4 font-semibold text-fg">{t(`setup.computer.${kind}.name`)}</span>
          <span className="text-sm leading-[1.45] text-fg-secondary">{description}</span>
          {warning && (
            <span className="flex w-fit items-center gap-1 rounded bg-warning-tint px-1.5 py-0.5 text-xs font-medium text-warning-strong">
              <TriangleAlert size={11} aria-hidden />
              {warning}
            </span>
          )}
        </span>
      </button>
      {children && selected && <div className="flex flex-col gap-2 px-3">{children}</div>}
    </div>
  )
}
