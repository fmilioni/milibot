import type { TFunction } from 'i18next'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatUsd } from '@/lib/format'

interface SettingChangeView {
  field: string
  from: unknown
  to: unknown
}

/** The `changes` param of a `workspace_settings` confirmation: `[{field, from, to}]` as JSON. */
export function parseSettingChanges(raw: string): SettingChangeView[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is SettingChangeView =>
        !!item && typeof item === 'object' && typeof (item as { field?: unknown }).field === 'string',
    )
  } catch {
    return []
  }
}

function valueText(field: string, value: unknown, t: TFunction, locale: string): string {
  if (field === 'spendWarnUsd' || field === 'spendPauseUsd')
    return typeof value === 'number'
      ? t('chat.confirmation.settings.perDay', { value: formatUsd(value, locale) })
      : t('chat.confirmation.settings.noLimit')
  if (typeof value === 'boolean') return t(`chat.confirmation.settings.${value ? 'on' : 'off'}`)
  if (field === 'promptUpdates' && typeof value === 'string')
    return t(`chat.confirmation.settings.promptUpdates.${value}`, { defaultValue: value })
  if (value === null || value === undefined) return '—'
  return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value)
}

/** What a bot asks to change in the workspace settings: each field with its current and proposed value. */
export function ProposedSettingChanges({ changes }: { changes: string }) {
  const { t, i18n } = useTranslation()
  const items = parseSettingChanges(changes)
  if (items.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
      {items.map((item) => (
        <li key={item.field} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-medium text-fg">
            {t(`chat.confirmation.settings.fields.${item.field}`, { defaultValue: item.field })}
          </span>
          <span className="text-fg-muted">{valueText(item.field, item.from, t, i18n.language)}</span>
          <ArrowRight size={12} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="font-semibold text-fg">{valueText(item.field, item.to, t, i18n.language)}</span>
        </li>
      ))}
    </ul>
  )
}
