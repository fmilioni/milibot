import { lazy, Suspense, useSyncExternalStore } from 'react'

import { CanvasWindow } from './windows/CanvasWindow'
import { MainWindow } from './windows/MainWindow'
import { VmWindow } from './windows/VmWindow'

const AvatarGallery = import.meta.env.DEV
  ? lazy(() => import('@/features/bots/avatar/AvatarGallery').then((m) => ({ default: m.AvatarGallery })))
  : null

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export function App() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  if (AvatarGallery && hash === '#/dev/avatars') {
    return (
      <Suspense fallback={null}>
        <AvatarGallery />
      </Suspense>
    )
  }
  if (hash.startsWith('#/vm?')) return <VmWindow params={new URLSearchParams(hash.slice('#/vm?'.length))} />
  if (hash.startsWith('#/canvas?'))
    return <CanvasWindow params={new URLSearchParams(hash.slice('#/canvas?'.length))} />
  return <MainWindow />
}
