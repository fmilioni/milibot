import type { TFunction } from 'i18next'
import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Screenshot } from '@/features/vm/Screenshot'
import { cn } from '@/lib/cn'

const BLOB_REF = /^milibot-blob:([0-9a-f]{64})$/
const LONG_STRING = 280
const OPEN_DEPTH = 2

function imageSha(value: unknown): string | null {
  if (typeof value === 'string') return BLOB_REF.exec(value)?.[1] ?? null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    if (o.type === 'image' && typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256)) return o.sha256
  }
  return null
}

function summary(value: unknown[] | Record<string, unknown>, t: TFunction): string {
  return Array.isArray(value)
    ? t('panels.debug.json.items', { count: value.length })
    : t('panels.debug.json.keys', { count: Object.keys(value).length })
}

function StringValue({ value }: { value: string }) {
  const { t } = useTranslation()
  const [full, setFull] = useState(false)
  const long = value.length > LONG_STRING
  const shown = long && !full ? `${value.slice(0, LONG_STRING)}…` : value
  return (
    <span className="break-words whitespace-pre-wrap text-success">
      {JSON.stringify(shown)}
      {long && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="focus-ring ml-1.5 rounded font-sans text-xs text-accent hover:underline"
        >
          {full ? t('panels.debug.showLess') : t('panels.debug.showMore', { count: value.length })}
        </button>
      )}
    </span>
  )
}

function Node({ name, value, depth }: { name: ReactNode; value: unknown; depth: number }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(depth < OPEN_DEPTH)
  const sha = imageSha(value)
  const label = name !== null ? <span className="text-fg-secondary">{name}: </span> : null

  if (sha) {
    return (
      <div className="flex items-start gap-2 py-0.5">
        {label}
        <Screenshot sha={sha} className="w-32" />
        <span className="font-mono text-2xs text-fg-muted">{sha.slice(0, 12)}…</span>
      </div>
    )
  }
  if (value === null || typeof value !== 'object') {
    return (
      <div>
        {label}
        {typeof value === 'string' ? (
          <StringValue value={value} />
        ) : (
          <span className={typeof value === 'number' ? 'text-accent' : 'text-warning'}>{String(value)}</span>
        )}
      </div>
    )
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (entries.length === 0) {
    return (
      <div>
        {label}
        <span className="text-fg-muted">{bracket.join('')}</span>
      </div>
    )
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focus-ring -ml-3.5 inline-flex items-center gap-0.5 rounded text-left hover:bg-surface-3/60"
      >
        <ChevronRight
          size={11}
          className={cn(
            'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        {label}
        <span className="text-fg-muted">
          {bracket[0]}
          {!open && ` ${summary(value as Record<string, unknown>, t)} ${bracket[1]}`}
        </span>
      </button>
      {open && (
        <div className="border-l border-border pl-3.5">
          {entries.map(([key, v]) => (
            <Node key={key} name={Array.isArray(value) ? null : key} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
      {open && <span className="text-fg-muted">{bracket[1]}</span>}
    </div>
  )
}

/** Collapsible JSON tree; screenshot references (`milibot-blob:<sha>`, image parts) render as thumbnails. */
export function JsonViewer({ value }: { value: unknown }) {
  return (
    <div className="selectable pl-3.5 font-mono text-xs leading-[16px] text-fg-secondary">
      <Node name={null} value={value} depth={0} />
    </div>
  )
}
