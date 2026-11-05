import type { GoldenStatus, VmInfo } from '@milibot/shared'
import { useState } from 'react'

import { type SetupVmProgress, setupVmProgress } from '@/features/setup/lib/setup'
import { useNow } from '@/hooks/use-now'

/** The image build and VM creation as one progress, counting the boot from when it started. */
export function useVmProgress(
  golden: GoldenStatus | null,
  vm: VmInfo | null,
  active: boolean,
): SetupVmProgress {
  const now = useNow(1000, active)
  const starting = vm?.state === 'starting'
  const [startingSince, setStartingSince] = useState<number | null>(null)
  if (starting && startingSince === null) {
    setStartingSince(now)
  }

  if (!starting && startingSince !== null) {
    setStartingSince(null)
  }

  const bootingForSeconds = startingSince !== null ? Math.max(0, now - startingSince) / 1000 : 0
  return setupVmProgress({ golden, vm, bootingForSeconds })
}
