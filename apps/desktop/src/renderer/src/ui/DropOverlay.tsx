import type { ReactNode } from 'react'

/** Dashed full-window target shown while files are dragged over the screen (see `useFileDrop`). */
export function DropOverlay({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="pointer-events-none fixed inset-3 z-overlay flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-bg/90 text-accent shadow-[inset_0_0_0_9999px_var(--accent-soft)]">
      {icon}
      <span className="text-md font-semibold">{title}</span>
      {hint && <span className="text-sm text-fg-secondary">{hint}</span>}
    </div>
  )
}
