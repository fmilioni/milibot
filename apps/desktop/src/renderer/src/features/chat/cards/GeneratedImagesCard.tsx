import type { GeneratedImagesPayload } from '@milibot/shared'
import { ImageOff, ImagePlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBlobSrc } from '@/features/workspace/use-blob-src'
import { cn } from '@/lib/cn'
import { formatUsd } from '@/lib/format'
import { ImagePreview } from '@/ui/ImagePreview'
import { Tooltip } from '@/ui/Tooltip'

type GeneratedImage = GeneratedImagesPayload['images'][number]

const fileName = (path: string | null) => path?.split('/').pop() ?? ''

function Tile({ image, single }: { image: GeneratedImage; single: boolean }) {
  const { t } = useTranslation()
  const src = useBlobSrc(image.sha)
  const [preview, setPreview] = useState(false)
  const name = fileName(image.path)
  const box = single ? 'max-h-[320px] max-w-[320px]' : 'max-h-[180px] w-full'
  const ratio = image.width && image.height ? `${image.width} / ${image.height}` : '1 / 1'

  if (image.status === 'generating')
    return (
      <div
        role="status"
        aria-label={t('chat.generatedImages.generating')}
        className={cn(single ? 'w-[260px]' : 'w-full', 'animate-pulse rounded-[10px] bg-surface-3')}
        style={{ aspectRatio: ratio }}
      />
    )
  if (image.status === 'failed')
    return (
      <div
        className={cn(
          single ? 'w-[260px]' : 'w-full',
          'flex flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-border text-fg-muted',
        )}
        style={{ aspectRatio: ratio }}
      >
        <ImageOff size={16} />
        <span className="px-3 text-center text-xs">
          {t(`chat.generatedImages.failures.${image.failure ?? 'error'}`)}
        </span>
      </div>
    )
  if (!src)
    return (
      <Tooltip content={image.path ?? ''}>
        <div
          className={cn(
            single ? 'w-[260px]' : 'w-full',
            'flex items-center justify-center rounded-[10px] border border-border bg-surface-3 px-2 text-center text-xs break-all text-fg-secondary',
          )}
          style={{ aspectRatio: ratio }}
        >
          {name}
        </div>
      </Tooltip>
    )
  return (
    <>
      <Tooltip content={image.path ?? ''}>
        <button
          type="button"
          onClick={() => setPreview(true)}
          aria-label={t('chat.attachments.openNamed', { name })}
          className="focus-ring block overflow-hidden rounded-[10px] border border-border"
        >
          <img src={src} alt={name} className={`block object-contain ${box}`} draggable={false} />
        </button>
      </Tooltip>
      {preview && <ImagePreview src={src} name={name} onClose={() => setPreview(false)} />}
    </>
  )
}

export function GeneratedImagesCard({ payload }: { payload: GeneratedImagesPayload }) {
  const { t, i18n } = useTranslation()
  const [showPrompts, setShowPrompts] = useState(false)
  const single = payload.images.length === 1
  const generating = payload.images.some((image) => image.status === 'generating')
  const details = [
    payload.model,
    payload.costUsd !== null && payload.costUsd > 0
      ? formatUsd(payload.costUsd, i18n.language, 'cost')
      : null,
  ].filter(Boolean)

  return (
    <div className="flex max-w-full flex-col gap-2">
      <div className={single ? 'flex' : 'grid w-[380px] max-w-full grid-cols-2 gap-2'}>
        {payload.images.map((image, i) => (
          <Tile key={i} image={image} single={single} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
        <ImagePlus size={12} className="shrink-0" />
        <span>{generating ? t('chat.generatedImages.generating') : details.join(' · ')}</span>
        <button
          type="button"
          onClick={() => setShowPrompts((v) => !v)}
          aria-expanded={showPrompts}
          className="focus-ring rounded text-fg-secondary underline-offset-2 hover:text-fg hover:underline"
        >
          {t(showPrompts ? 'chat.generatedImages.hidePrompt' : 'chat.generatedImages.showPrompt', {
            count: payload.prompts.length,
          })}
        </button>
      </div>
      {showPrompts && (
        <ol className="flex max-w-[520px] flex-col gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm leading-relaxed text-fg-secondary">
          {payload.prompts.map((prompt, i) => (
            <li key={i} className="whitespace-pre-wrap">
              {payload.prompts.length > 1 ? <span className="mr-1 text-fg-muted">{i + 1}.</span> : null}
              {prompt}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
