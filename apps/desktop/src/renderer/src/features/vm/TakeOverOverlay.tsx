import { Hand } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'

const IDLE_MS = 2000

/**
 * Covers a view-only screen: moving the pointer over it dims the screen and shows "Take control" in the
 * middle; after IDLE_MS without movement it fades back out (unless the pointer or focus is on the button).
 */
export function TakeOverOverlay({ busy, onTakeOver }: { busy: boolean; onTakeOver: () => void }) {
  const { t } = useTranslation()
  const [moving, setMoving] = useState(false)
  const [onButton, setOnButton] = useState(false)
  const [focused, setFocused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  const visible = moving || onButton || focused || busy
  return (
    <div
      className="absolute inset-0"
      onPointerMove={() => {
        setMoving(true)
        clearTimer()
        timer.current = setTimeout(() => setMoving(false), IDLE_MS)
      }}
      onPointerLeave={() => {
        clearTimer()
        setMoving(false)
      }}
    >
      <div
        className={cn(
          'flex h-full items-center justify-center bg-black/20 transition-opacity duration-200 motion-reduce:transition-none',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      >
        <Button
          variant="primary"
          disabled={busy}
          className={visible ? '' : 'pointer-events-none'}
          onPointerEnter={() => setOnButton(true)}
          onPointerLeave={() => setOnButton(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onClick={onTakeOver}
        >
          <Hand size={14} />
          {t('panels.vm.takeOver')}
        </Button>
      </div>
    </div>
  )
}
