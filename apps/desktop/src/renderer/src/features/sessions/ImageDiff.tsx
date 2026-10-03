import type { SessionChangedFile, SessionFileImages, SessionImage } from '@milibot/shared'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { readSessionPref, splitPath, writeSessionPref } from '@/features/sessions/lib/session-view'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { AsyncView } from '@/ui/AsyncView'
import { ImagePreview } from '@/ui/ImagePreview'
import { Tooltip } from '@/ui/Tooltip'

import { diffKey, useSessionStore } from './store'

/** Tiny images (icons) are enlarged by whole steps up to this size so their pixels can be told apart. */
const SMALL_IMAGE_TARGET = 128

type Backdrop = 'light' | 'dark'

function initialBackdrop(): Backdrop {
  const saved = readSessionPref('imageBackdrop')
  if (saved === 'light' || saved === 'dark') return saved
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function ImageSide({
  side,
  image,
  name,
  backdrop,
}: {
  side: 'before' | 'after'
  image: SessionImage
  name: string
  backdrop: Backdrop
}) {
  const { t, i18n } = useTranslation()
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [preview, setPreview] = useState(false)
  const src = image.data && image.mediaType ? `data:${image.mediaType};base64,${image.data}` : null
  const size = formatBytes(image.bytes, i18n.language)
  const scale = natural
    ? Math.max(1, Math.floor(SMALL_IMAGE_TARGET / Math.max(natural.width, natural.height, 1)))
    : 1
  const label = t(side === 'before' ? 'session.diff.imageBefore' : 'session.diff.imageAfter')

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex items-center gap-2 text-xs font-semibold text-fg-secondary">
        <span
          className={cn('size-2 rounded-full', side === 'before' ? 'bg-danger' : 'bg-success')}
          aria-hidden
        />
        {label}
      </figcaption>
      {src ? (
        <button
          type="button"
          onClick={() => setPreview(true)}
          aria-label={`${label}: ${name}`}
          data-backdrop={backdrop}
          className={cn(
            'image-checker focus-ring flex min-h-40 items-center justify-center overflow-hidden rounded-lg border p-4',
            side === 'before' ? 'border-danger-soft' : 'border-success-soft',
          )}
        >
          <img
            src={src}
            alt=""
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            style={
              natural && scale > 1 ? { width: natural.width * scale, imageRendering: 'pixelated' } : undefined
            }
            className="block max-h-[60vh] max-w-full object-contain"
          />
        </button>
      ) : (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border px-6 text-center text-sm text-fg-muted">
          {t('session.diff.imageTooLarge', { size })}
        </div>
      )}
      {src && (
        <span className="font-mono text-xs text-fg-muted tabular-nums">
          {natural
            ? t('session.diff.imageMeta', { width: natural.width, height: natural.height, size })
            : size}
        </span>
      )}
      {preview && src && <ImagePreview src={src} name={name} onClose={() => setPreview(false)} />}
    </figure>
  )
}

const CENTERED =
  'flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-fg-muted'

/** A changed image as it was when the session started and as it is now. */
export function ImageDiff({ sessionId, file }: { sessionId: string; file: SessionChangedFile }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const entry = useSessionStore((s) => s.fileImages[diffKey(sessionId, file.path)])
  const loadFileImages = useSessionStore((s) => s.loadFileImages)
  const needsLoad = !entry || (!entry.loading && (entry.stale === true || (!entry.data && !entry.error)))

  useEffect(() => {
    if (needsLoad) void loadFileImages(workspaceId, sessionId, file.path)
  }, [needsLoad, loadFileImages, workspaceId, sessionId, file.path])

  return (
    <AsyncView
      data={entry?.data}
      error={entry?.error}
      onRetry={() => void loadFileImages(workspaceId, sessionId, file.path)}
      errorText={t('session.diff.imageLoadFailed')}
      className={CENTERED}
    >
      {(images) =>
        images.before || images.after ? (
          <ImagePair images={images} file={file} />
        ) : (
          <div className={CENTERED}>{t('session.diff.binary')}</div>
        )
      }
    </AsyncView>
  )
}

function ImagePair({ images, file }: { images: SessionFileImages; file: SessionChangedFile }) {
  const { t } = useTranslation()
  const [backdrop, setBackdrop] = useState(initialBackdrop)
  const next: Backdrop = backdrop === 'dark' ? 'light' : 'dark'
  const toggleLabel = t(
    next === 'light' ? 'session.diff.imageBackdropLight' : 'session.diff.imageBackdropDark',
  )
  const switchBackdrop = () => {
    setBackdrop(next)
    writeSessionPref('imageBackdrop', next)
  }
  return (
    <div className="scroll-slim relative min-h-0 flex-1 overflow-auto p-4">
      <Tooltip content={toggleLabel}>
        <button
          type="button"
          onClick={switchBackdrop}
          aria-label={toggleLabel}
          className="focus-ring absolute top-3 right-4 flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
        >
          {next === 'light' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </Tooltip>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        {images.before && (
          <ImageSide
            side="before"
            image={images.before}
            name={splitPath(file.oldPath ?? file.path).name}
            backdrop={backdrop}
          />
        )}
        {images.after && (
          <ImageSide side="after" image={images.after} name={splitPath(file.path).name} backdrop={backdrop} />
        )}
      </div>
    </div>
  )
}
