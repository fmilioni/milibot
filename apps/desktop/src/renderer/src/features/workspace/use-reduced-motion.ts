import { useSystemReducedMotion } from '@/hooks/use-system-reduced-motion'

import { useAppStore } from './store'

/** The app's "Reduce motion" setting, falling back to the system preference. */
export function useReducedMotion(): boolean {
  const systemReduce = useSystemReducedMotion()
  const reduceMotion = useAppStore((s) => s.appSettings.reduceMotion)
  return reduceMotion ?? systemReduce
}
