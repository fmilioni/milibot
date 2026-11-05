import { SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cliEngineNames } from '@/lib/cli-engines'

/** Shown where the CLI engines would be listed when the workspace has no computer to run them. */
export function CliNeedsVmNote() {
  const { t, i18n } = useTranslation()

  return (
    <p className="flex items-center gap-2 rounded-[10px] border border-dashed border-border px-3 py-2.5 text-sm leading-[1.45] text-fg-secondary">
      <SquareTerminal size={14} className="shrink-0 text-fg-muted" aria-hidden />
      {t('settings.providers.cliNeedsVm', { engines: cliEngineNames(i18n.language) })}
    </p>
  )
}
