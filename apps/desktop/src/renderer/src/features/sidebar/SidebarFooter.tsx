import { Bug, RotateCcw, Settings } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { formatClock, formatTokens, formatUsd } from '@/lib/format'
import { Menu } from '@/ui/Menu'
import { MetaText } from '@/ui/MetaText'
import { Tooltip } from '@/ui/Tooltip'

import { ActiveWorkLine } from './ActiveWorkLine'
import { KeepAwakeIndicator } from './KeepAwakeIndicator'
import { UsageCards } from './UsageCards'
import { VmStatusLine } from './VmStatusLine'

export function SidebarFooter() {
  const { t, i18n } = useTranslation()
  const status = useAppStore((s) => s.status)
  const vm = useAppStore((s) => s.vm)
  const rightPanel = useAppStore((s) => s.rightPanel)
  const toggle = useAppStore((s) => s.toggleRightPanel)
  const openSettings = useAppStore((s) => s.openSettings)
  const state = vm?.state ?? status?.vm.state ?? 'not_created'
  const desktops = vm?.desktops ?? status?.vm.desktops ?? 0
  const resetUsageCounter = useAppStore((s) => s.resetUsageCounter)
  const [counterMenu, setCounterMenu] = useState<{ x: number; y: number } | null>(null)
  const counter = status?.usageCounter ?? {
    ...(status?.usageToday ?? { costUsd: 0, tokens: 0 }),
    reset: false,
    since: 0,
  }
  const counterText = counter.reset
    ? t('footer.usageSince', {
        cost: formatUsd(counter.costUsd, i18n.language),
        time: formatClock(counter.since, i18n.language),
        tokens: formatTokens(counter.tokens, i18n.language),
      })
    : t('footer.usage', {
        cost: formatUsd(counter.costUsd, i18n.language),
        tokens: formatTokens(counter.tokens, i18n.language),
      })
  const openCounterMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setCounterMenu({ x: e.clientX, y: e.clientY })
  }
  const vmLabel = state === 'running' ? t('footer.vm.running', { count: desktops }) : t(`footer.vm.${state}`)
  const vmDot =
    state === 'running'
      ? 'bg-success'
      : state === 'error'
        ? 'bg-danger'
        : state === 'starting'
          ? 'bg-warning'
          : 'bg-fg-muted'

  return (
    <footer className="mx-3 mb-4 flex flex-col gap-2.5 border-t border-border pt-3">
      <UsageCards />
      <ActiveWorkLine />
      <VmStatusLine label={vmLabel} dot={vmDot} running={state === 'running'} />
      <div className="flex items-center justify-between gap-2 px-1">
        <Tooltip content={t('footer.counterHint')}>
          <button
            type="button"
            onClick={openCounterMenu}
            onContextMenu={openCounterMenu}
            className="focus-ring min-w-0 truncate rounded text-left text-sm leading-4 text-fg-muted hover:text-fg-secondary"
          >
            <MetaText text={counterText} />
          </button>
        </Tooltip>
        {counterMenu && (
          <Menu
            x={counterMenu.x}
            y={counterMenu.y}
            width={190}
            onClose={() => setCounterMenu(null)}
            label={t('footer.resetCounter')}
            entries={[
              {
                key: 'reset',
                label: t('footer.resetCounter'),
                icon: <RotateCcw size={14} />,
                onSelect: () => void resetUsageCounter(),
              },
            ]}
          />
        )}
        <div className="flex shrink-0 items-center gap-3 text-fg-secondary">
          <KeepAwakeIndicator />
          <Tooltip content={t('footer.debug')}>
            <button
              type="button"
              aria-label={t('footer.debug')}
              aria-pressed={rightPanel === 'debug'}
              onClick={() => toggle('debug')}
              className={cn('focus-ring rounded', rightPanel === 'debug' ? 'text-accent' : 'hover:text-fg')}
            >
              <Bug size={15} />
            </button>
          </Tooltip>
          <Tooltip content={t('footer.settings')}>
            <button
              type="button"
              aria-label={t('footer.settings')}
              onClick={() => openSettings()}
              className="focus-ring rounded hover:text-fg"
            >
              <Settings size={15} />
            </button>
          </Tooltip>
        </div>
      </div>
    </footer>
  )
}
