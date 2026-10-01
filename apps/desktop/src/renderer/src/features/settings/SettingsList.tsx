import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Spinner } from '@/ui/Spinner'

import { SettingsCard } from './SettingsLayout'

/** A card listing `items`: a spinner on the first load, `empty` when there is nothing. */
export function SettingsList<T>({
  items,
  loading,
  empty,
  children,
}: {
  items: T[]
  loading: boolean
  empty: string
  children: (item: T) => ReactNode
}) {
  const { t } = useTranslation()
  return (
    <SettingsCard>
      {loading && items.length === 0 ? (
        <div className="px-4 py-4 text-fg-muted">
          <Spinner label={t('common.loading')} />
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-fg-muted">{empty}</div>
      ) : (
        <ul className="flex flex-col">{items.map(children)}</ul>
      )}
    </SettingsCard>
  )
}

/** A clickable row of a `SettingsList`: icon, then the content. */
export function SettingsListRow({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode
  onClick: () => void
  children: ReactNode
}) {
  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={onClick}
        className="focus-ring flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-3/40"
      >
        <span className="mt-0.5 flex shrink-0 text-fg-muted" aria-hidden>
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      </button>
    </li>
  )
}
