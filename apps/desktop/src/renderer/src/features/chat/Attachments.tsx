import { ApiError, type MessageAttachment } from '@milibot/shared'
import {
  BookCheck,
  BookPlus,
  CircleAlert,
  Download,
  File,
  FileArchive,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  type LucideIcon,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type AttachmentKind, attachmentKind } from '@/features/chat/lib/attachment-upload'
import { fileErrorToast, openChatFile, revealChatFile, saveChatFile } from '@/features/files/store'
import { useKnowledgeStore } from '@/features/knowledge/store'
import { useAppStore } from '@/features/workspace/store'
import { useBlobSrc } from '@/features/workspace/use-blob-src'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { ImagePreview } from '@/ui/ImagePreview'
import { Tooltip } from '@/ui/Tooltip'

import type { PendingAttachment } from './attachment-store'

const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
  image: ImageIcon,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  file: File,
}

/** Chips of the files being attached in the composer (progress, errors, remove). */
export function ComposerAttachments({
  items,
  maxFileMb,
  onRemove,
}: {
  items: PendingAttachment[]
  maxFileMb: number
  onRemove: (key: string) => void
}) {
  const { t, i18n } = useTranslation()
  return (
    <div className="flex flex-wrap gap-2" aria-label={t('chat.attachments.list')}>
      {items.map((item) => {
        const kind = attachmentKind(item.type, item.name)
        const Icon = KIND_ICONS[kind]
        const status = item.attachment?.status
        const busy = !item.error && (!item.attachment || status === 'uploading' || status === 'copying')
        const progress =
          !item.attachment || status === 'uploading' ? item.uploaded : (item.attachment?.progress ?? 0)
        const detail = item.error
          ? item.error === 'too_large'
            ? t('chat.attachments.tooLarge', { max: maxFileMb })
            : t('chat.attachments.failed')
          : status === 'queued'
            ? t('chat.attachments.waitingVm')
            : status === 'copying'
              ? t('chat.attachments.copying', { percent: Math.round(progress * 100) })
              : status === 'failed'
                ? t('chat.attachments.failed')
                : status === 'ready'
                  ? formatBytes(item.size, i18n.language)
                  : t('chat.attachments.uploading', { percent: Math.round(progress * 100) })
        const failed = Boolean(item.error) || status === 'failed'
        return (
          <div
            key={item.key}
            className={cn(
              'relative flex h-[42px] max-w-[260px] items-center gap-2 overflow-hidden rounded-lg border bg-surface pr-1.5 pl-1.5',
              failed ? 'border-danger-soft' : 'border-border',
            )}
          >
            {item.previewUrl ? (
              <img src={item.previewUrl} alt="" className="size-[30px] shrink-0 rounded-[5px] object-cover" />
            ) : (
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[5px] bg-surface-3 text-fg-secondary">
                <Icon size={15} />
              </span>
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-fg">{item.name}</span>
              <span
                className={cn(
                  'flex items-center gap-1 truncate text-xs',
                  failed ? 'text-danger' : 'text-fg-muted',
                )}
              >
                {busy && <LoaderCircle size={10} className="shrink-0 animate-spin" />}
                {failed && <CircleAlert size={10} className="shrink-0" />}
                {detail}
              </span>
            </span>
            <Tooltip content={t('chat.attachments.remove')}>
              <button
                type="button"
                onClick={() => onRemove(item.key)}
                aria-label={t('chat.attachments.removeNamed', { name: item.name })}
                className="focus-ring ml-0.5 shrink-0 rounded p-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg"
              >
                <X size={13} />
              </button>
            </Tooltip>
            {busy && (
              <span
                className="absolute bottom-0 left-0 h-[2px] bg-accent transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Kinds opened right away with the default app; the others (zips, binaries) are saved where the user picks. */
const OPENABLE_KINDS: ReadonlySet<AttachmentKind> = new Set(['image', 'pdf', 'text'])

function MessageAttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const [preview, setPreview] = useState(false)
  const src = useBlobSrc(attachment.image?.sha256)
  const kind = attachmentKind(attachment.mimeType, attachment.name)
  const Icon = KIND_ICONS[kind]
  const removed = attachment.status === 'removed'
  const status =
    attachment.status === 'queued'
      ? t('chat.attachments.waitingVm')
      : attachment.status === 'copying'
        ? t('chat.attachments.copyingShort')
        : attachment.status === 'failed'
          ? t('chat.attachments.failed')
          : removed
            ? t('chat.attachments.removed')
            : null

  const failed = (err: unknown) => showToast(fileErrorToast(err))
  const save = () => {
    saveChatFile(workspaceId, attachment, t('chat.attachments.saveTitle'))
      .then((saved) => saved && showToast('fileSaved'))
      .catch(failed)
  }
  const open = () => {
    if (src) {
      setPreview(true)
      return
    }
    if (!OPENABLE_KINDS.has(kind)) {
      save()
      return
    }
    openChatFile(workspaceId, attachment.id).catch(failed)
  }
  const reveal = () => {
    revealChatFile(workspaceId, attachment.id).catch(failed)
  }

  if (removed)
    return (
      <div className="flex h-[42px] max-w-[280px] items-center gap-2 rounded-lg border border-dashed border-border pr-2 pl-1.5 opacity-70">
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[5px] bg-surface-3 text-fg-muted">
          <Icon size={15} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-fg-secondary line-through">
            {attachment.name}
          </span>
          <span className="truncate text-xs text-fg-muted">{status}</span>
        </span>
      </div>
    )

  const knowledgeButton = <KnowledgeButton attachment={attachment} />

  const saveButton = (
    <Tooltip content={t('chat.attachments.save')}>
      <button
        type="button"
        onClick={save}
        aria-label={t('chat.attachments.saveNamed', { name: attachment.name })}
        className="focus-ring shrink-0 rounded p-1 text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100"
      >
        <Download size={13} />
      </button>
    </Tooltip>
  )

  const revealButton = (
    <Tooltip content={t('chat.attachments.reveal')}>
      <button
        type="button"
        onClick={reveal}
        aria-label={t('chat.attachments.revealNamed', { name: attachment.name })}
        className="focus-ring shrink-0 rounded p-1 text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100"
      >
        <FolderOpen size={13} />
      </button>
    </Tooltip>
  )

  if (src && attachment.image) {
    return (
      <div className="group relative">
        <Tooltip content={attachment.path}>
          <button
            type="button"
            onClick={open}
            aria-label={t('chat.attachments.openNamed', { name: attachment.name })}
            className="focus-ring block overflow-hidden rounded-[10px] border border-border"
          >
            <img
              src={src}
              alt={attachment.name}
              className="block max-h-[180px] max-w-[260px] object-contain"
              draggable={false}
            />
          </button>
        </Tooltip>
        <span className="absolute top-1 right-1 flex rounded-md bg-surface-2/90 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-in-knowledge]]:opacity-100">
          {knowledgeButton}
          {saveButton}
          {revealButton}
        </span>
        {preview && <ImagePreview src={src} name={attachment.name} onClose={() => setPreview(false)} />}
      </div>
    )
  }

  return (
    <div className="group flex h-[42px] max-w-[280px] items-center gap-2 rounded-lg border border-border bg-surface-2 pr-1 pl-1.5">
      <Tooltip content={attachment.path}>
        <button
          type="button"
          onClick={open}
          aria-label={t(
            OPENABLE_KINDS.has(kind) ? 'chat.attachments.openNamed' : 'chat.attachments.saveNamed',
            {
              name: attachment.name,
            },
          )}
          className="focus-ring flex min-w-0 items-center gap-2 rounded-md text-left"
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[5px] bg-surface-3 text-fg-secondary">
            <Icon size={15} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-fg">{attachment.name}</span>
            <span
              className={cn(
                'truncate text-xs',
                attachment.status === 'failed' ? 'text-danger' : 'text-fg-muted',
              )}
            >
              {status ?? formatBytes(attachment.size, i18n.language)}
            </span>
          </span>
        </button>
      </Tooltip>
      {knowledgeButton}
      {saveButton}
      {revealButton}
    </div>
  )
}

/** "Add to knowledge" (a copy of the file; adding again returns the same document). */
function KnowledgeButton({ attachment }: { attachment: MessageAttachment }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const openSettings = useAppStore((s) => s.openSettings)
  const added = useKnowledgeStore((s) => Boolean(s.fromAttachments[attachment.id]))
  const addFromAttachment = useKnowledgeStore((s) => s.addFromAttachment)
  const [busy, setBusy] = useState(false)

  if (added)
    return (
      <Tooltip content={t('chat.attachments.inKnowledge')}>
        <button
          type="button"
          data-in-knowledge
          onClick={() => openSettings('knowledge')}
          aria-label={t('chat.attachments.inKnowledge')}
          className="focus-ring shrink-0 rounded p-1 text-success hover:bg-surface-3"
        >
          <BookCheck size={13} />
        </button>
      </Tooltip>
    )

  const add = () => {
    setBusy(true)
    addFromAttachment(workspaceId, attachment.id)
      .then(() => showToast('addedToKnowledge'))
      .catch((err: unknown) =>
        showToast(err instanceof ApiError && err.code === 'conflict' ? 'attachmentUnavailable' : 'error'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Tooltip content={t('chat.attachments.addToKnowledge')}>
      <button
        type="button"
        onClick={add}
        disabled={busy}
        aria-label={t('chat.attachments.addToKnowledgeNamed', { name: attachment.name })}
        className="focus-ring shrink-0 rounded p-1 text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 disabled:opacity-60"
      >
        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <BookPlus size={13} />}
      </button>
    </Tooltip>
  )
}

/**
 * An image the bot's markdown places in its text: the message's copy of it once the daemon attaches it
 * (when the reply ends), a chip with its name until then or when it can't be attached.
 */
export function InlineImage({
  src,
  alt,
  attachment,
}: {
  src: string
  alt: string
  attachment: MessageAttachment | undefined
}) {
  if (attachment) return <MessageAttachmentChip attachment={attachment} />
  return (
    <Tooltip content={src}>
      <span className="inline-flex max-w-[280px] items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 align-middle text-sm text-fg-secondary">
        <ImageIcon size={13} className="shrink-0 text-fg-muted" />
        <span className="truncate">{alt || src.split('/').pop()}</span>
      </span>
    </Tooltip>
  )
}

/** Files of a message: image thumbnails (click to preview) and file chips (click to open or save). */
export function MessageAttachments({
  attachments,
  align = 'end',
}: {
  attachments: MessageAttachment[]
  align?: 'start' | 'end'
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', align === 'end' ? 'justify-end' : 'justify-start')}>
      {attachments.map((attachment) => (
        <MessageAttachmentChip key={attachment.id} attachment={attachment} />
      ))}
    </div>
  )
}
