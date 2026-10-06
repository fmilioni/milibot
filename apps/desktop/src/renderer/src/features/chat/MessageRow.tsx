import type { Bot, Message, MessageAttachment } from '@milibot/shared'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { splitFrameContext } from '@/features/canvas/lib/canvas'
import { useTextReveal } from '@/features/chat/hooks/use-text-reveal'
import { imageSourcePath } from '@/features/chat/lib/inline-images'
import { toMessageView } from '@/features/chat/lib/message-view'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import type { MentionTarget } from '@/lib/mentions'
import { shouldAnimateReveal } from '@/lib/reveal'
import { linkifiedNodes } from '@/ui/LinkifiedText'
import { Markdown, withMentions } from '@/ui/Markdown'
import { Tooltip } from '@/ui/Tooltip'

import { InlineImage, MessageAttachments } from './Attachments'
import { FrameChip } from './FrameChip'
import { messageBody } from './MessageBody'

/**
 * `internal`: read-only bot↔bot thread as bubbles, the bot that started it (`rightBotId`) on the
 * right and the other on the left.
 */
export interface InternalLayout {
  rightBotId: string | null
}

export function MessageRow({
  message,
  continued,
  bots,
  mentions,
  showRoleChips,
  reduced,
  internal,
}: {
  message: Message
  continued: boolean
  bots: Record<string, Bot>
  mentions: MentionTarget[]
  showRoleChips: boolean
  reduced: boolean
  internal: InternalLayout | undefined
}) {
  const { t, i18n } = useTranslation()
  const view = toMessageView(message)
  const bot = message.authorBotId ? bots[message.authorBotId] : undefined
  const { node: body, standalone } = messageBody(view, message, {
    bots,
    bot,
    mentions,
    showRoleChips,
    reduced,
    internal: Boolean(internal),
  })
  if (standalone) return body

  if (message.authorType === 'user') {
    const attached = message.payload?.type === 'user_message' ? message.payload : null
    const { frame, element, text } = splitFrameContext(attached ? attached.text : message.content)
    const chip = element
      ? element.label
        ? t('canvas.elementChip', { tag: element.tag, label: element.label, frame: element.frame })
        : t('canvas.elementChipBare', { tag: element.tag, frame: element.frame })
      : frame && t('canvas.chip', { name: frame })
    return (
      <div className="flex flex-col items-end gap-1.5">
        {chip && <FrameChip label={chip} className="max-w-[75%]" />}
        {text.trim() && (
          <Tooltip content={formatClock(message.createdAt, i18n.language)} side="left">
            <div className="selectable max-w-[75%] rounded-[14px_14px_4px_14px] bg-surface-3 px-3.5 py-2.5 text-md leading-[1.5] break-words whitespace-pre-wrap text-fg">
              {withMentions(linkifiedNodes(text), mentions)}
            </div>
          </Tooltip>
        )}
        {attached && attached.attachments.length > 0 && (
          <div className="max-w-[75%]">
            <MessageAttachments attachments={attached.attachments} />
          </div>
        )}
      </div>
    )
  }

  if (internal) {
    const right = Boolean(bot) && bot?.id === internal.rightBotId
    const time = formatClock(message.createdAt, i18n.language)
    return (
      <div className={cn('flex items-start gap-2.5', right && 'flex-row-reverse')}>
        {bot && !continued ? (
          <BotAvatar avatar={bot.avatar} state={bot.status} size={26} className="shrink-0" />
        ) : (
          <div className="w-[26px] shrink-0" />
        )}
        {view.type === 'text' ? (
          <div
            className={cn(
              'flex max-w-[80%] min-w-0 flex-col gap-1 rounded-[12px] border border-border px-3 py-2.5',
              right ? 'rounded-br-[4px] bg-surface-3' : 'rounded-bl-[4px] bg-surface-2',
            )}
          >
            {!continued && (
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold text-fg">{bot?.name ?? t('chat.system')}</span>
                <span className="text-xs text-fg-muted">{time}</span>
              </div>
            )}
            {body}
          </div>
        ) : (
          <div className="w-[80%] min-w-0">{body}</div>
        )}
      </div>
    )
  }

  if (continued) return <div className="pl-10">{body}</div>

  return (
    <div className="flex gap-3">
      {bot ? (
        <BotAvatar avatar={bot.avatar} state={bot.status} size={28} className="shrink-0" />
      ) : (
        <div className="size-7 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex h-4 items-center gap-2">
          <span className="text-base font-semibold text-fg">{bot?.name ?? t('chat.system')}</span>
          {showRoleChips && bot?.label && (
            <span className="rounded-[5px] bg-surface-3 px-1.5 py-px text-2xs leading-3 text-fg-secondary">
              {bot.label}
            </span>
          )}
          <span className="text-xs text-fg-muted">{formatClock(message.createdAt, i18n.language)}</span>
        </div>
        {body}
      </div>
    </div>
  )
}

const NO_IMAGES: MessageAttachment[] = []

function inlineImageRenderer(images: MessageAttachment[]) {
  const byPath = new Map(images.map((a) => [a.path, a]))
  return (src: string, alt: string) => (
    <InlineImage src={imageSourcePath(src)} alt={alt} attachment={byPath.get(imageSourcePath(src))} />
  )
}

export function BotText({
  message,
  text = message.content,
  streaming,
  mentions,
  reduced,
  compact,
  images = NO_IMAGES,
}: {
  message: Message
  text?: string
  streaming: boolean
  mentions: MentionTarget[]
  reduced: boolean
  compact: boolean
  /** Attachments the markdown shows inline (`splitInlineImages`). */
  images?: MessageAttachment[]
}) {
  const { t } = useTranslation()
  const imagesKey = images.map((a) => `${a.id}:${a.status}:${a.image?.sha256 ?? ''}`).join()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content: `images` is a new array on every render
  const renderImage = useMemo(() => inlineImageRenderer(images), [imagesKey])
  const [live] = useState(() => shouldAnimateReveal(message, streaming, Date.now()))
  const reveal = useTextReveal(message.id, text, streaming, live && !reduced)
  const decorations = useMemo(
    () => (reveal.active ? { chunks: reveal.chunks, caret: true } : undefined),
    [reveal.active, reveal.chunks],
  )
  return (
    <div
      className="flex flex-col"
      aria-busy={reveal.active || undefined}
      data-reduced-motion={reduced || undefined}
    >
      {reveal.source ? (
        <Markdown
          text={reveal.source}
          mentions={mentions}
          reveal={decorations}
          compact={compact}
          renderImage={renderImage}
        />
      ) : (
        reveal.active && <span className="stream-caret" aria-label={t('chat.streaming')} />
      )}
    </div>
  )
}
