import { ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useVmStats } from '@/features/vm/use-vm-stats'
import { VmUsagePopover } from '@/features/vm/VmUsagePopover'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { MetaText } from '@/ui/MetaText'
import { Popover } from '@/ui/Popover'

/** "VM running · N desktops"; while the VM runs, a click opens its usage (charts, disks, bots). */
export function VmStatusLine({ label, dot, running }: { label: string; dot: string; running: boolean }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const openSettings = useAppStore((s) => s.openSettings)
  const [button, setButton] = useState<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const open = running && anchor !== null
  const stats = useVmStats(workspaceId, open)

  const content = (
    <>
      <span className={`size-[7px] shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1 truncate text-left text-sm leading-4 text-fg-secondary">
        <MetaText text={label} />
      </span>
    </>
  )

  if (!running) return <div className="flex items-center gap-2 px-1">{content}</div>

  return (
    <>
      <button
        ref={setButton}
        type="button"
        aria-expanded={open}
        aria-label={`${label} — ${t('footer.vm.usageHint')}`}
        onClick={() => setAnchor(open ? null : (button?.getBoundingClientRect() ?? null))}
        className={cn(
          'focus-ring group -my-1 flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-3',
          open && 'bg-surface-3',
        )}
      >
        {content}
        <ChevronUp
          size={12}
          aria-hidden
          className={cn(
            'shrink-0 group-hover:text-fg-secondary',
            open ? 'text-fg-secondary' : 'text-fg-muted',
          )}
        />
      </button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above-start"
          trigger={button}
          label={t('vmUsage.title')}
          onClose={() => setAnchor(null)}
        >
          <VmUsagePopover
            stats={stats}
            onAdjust={() => {
              setAnchor(null)
              openSettings('vm')
            }}
          />
        </Popover>
      )}
    </>
  )
}
