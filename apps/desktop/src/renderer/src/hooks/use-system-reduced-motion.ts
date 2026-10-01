import { useSyncExternalStore } from 'react'

const query = window.matchMedia('(prefers-reduced-motion: reduce)')

function subscribe(onChange: () => void): () => void {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => query.matches)
}
