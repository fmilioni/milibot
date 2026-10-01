import { useAppStore } from '@/features/workspace/store'
import { useSystemReducedMotion } from '@/hooks/use-system-reduced-motion'

import { resolveMotionPrefs } from './motion-model'

export interface MotionPrefs {
  /** Springs between avatar states; when false, poses change instantly. */
  transitions: boolean
  /** Blinks, glances, saccades, drift and shake. */
  micro: boolean
}

export function useMotionPrefs(): MotionPrefs {
  const systemReduce = useSystemReducedMotion()
  const animateEyes = useAppStore((s) => s.appSettings.animateEyes)
  const reduceMotion = useAppStore((s) => s.appSettings.reduceMotion)
  const { transitions, micro } = resolveMotionPrefs(animateEyes, reduceMotion, systemReduce)
  return { transitions, micro }
}
