import { FileText } from 'lucide-react'
import { createContext, type ReactNode, useContext } from 'react'

/**
 * How ids of the app and `/workspace/` paths found in text are shown. The provider (mounted by the windows
 * that can open them) turns them into links; without it they stay text.
 */
export interface RefLinkRenderers {
  /** An id (`bcd_…`); `label` replaces the item's name when the text gave one (`[text](bcd_…)`). */
  renderRef: (id: string, label?: ReactNode) => ReactNode
  /** A file path; `chip`: the inline-code look; `label` replaces the path when the text gave one. */
  renderPath: (path: string, variant: 'text' | 'chip', label?: ReactNode) => ReactNode
}

export const RefLinkContext = createContext<RefLinkRenderers | null>(null)

export function RefText({ id, label }: { id: string; label?: ReactNode }) {
  const renderers = useContext(RefLinkContext)
  return renderers ? renderers.renderRef(id, label) : <>{label ?? id}</>
}

export function PathText({
  path,
  variant,
  label,
}: {
  path: string
  variant: 'text' | 'chip'
  label?: ReactNode
}) {
  const renderers = useContext(RefLinkContext)
  if (renderers) return renderers.renderPath(path, variant, label)
  return variant === 'chip' ? <FileChip path={path} /> : <>{label ?? path}</>
}

/** A file path shown like inline code with a file icon. */
export function FileChip({ path }: { path: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5 align-[-2px] font-mono text-sm text-fg-secondary">
      <FileText size={12} className="shrink-0 text-fg-muted" />
      <span className="truncate">{path}</span>
    </span>
  )
}
