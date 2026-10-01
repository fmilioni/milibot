import type { Bot } from '@milibot/shared'
import { ArrowUp, LoaderCircle, Paperclip, Square } from 'lucide-react'
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { type ComposerSession, useChatStop } from '@/features/chat/hooks/use-chat-stop'
import { pastedFileName } from '@/features/chat/lib/attachment-upload'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { activeMentionQuery, filterMentionTargets, insertMention, type MentionQuery } from '@/lib/mentions'
import { Tooltip } from '@/ui/Tooltip'

import { sendableAttachmentIds, useAttachmentStore } from './attachment-store'
import { ComposerAttachments } from './Attachments'
import { FrameChip } from './FrameChip'

const MAX_COMPOSER_HEIGHT = 200
const NO_ATTACHMENTS: never[] = []

/** What the next message is about (a design frame): a removable chip; `prefix` goes before the text. */
export interface ComposerContext {
  label: string
  removeLabel: string
  prefix: string
  /** Changes when the context is set again (focuses the composer). */
  focusKey: number
  onClear: () => void
}

export function Composer({
  conversationId,
  targetName,
  members,
  session,
  context,
  placeholder,
  wide = true,
}: {
  conversationId: string
  targetName: string
  members: Bot[]
  session?: ComposerSession
  context?: ComposerContext
  placeholder?: string
  /** False in narrow columns (the canvas chat): less padding around the box. */
  wide?: boolean
}) {
  const { t } = useTranslation()
  const send = useAppStore((s) => s.sendMessage)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(false)
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [active, setActive] = useState(0)
  const [shownConversation, setShownConversation] = useState(conversationId)
  if (shownConversation !== conversationId) {
    setShownConversation(conversationId)
    setError(false)
    setMention(null)
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const value = drafts[conversationId] ?? ''
  const attachments = useAttachmentStore((s) => s.byConversation[conversationId]) ?? NO_ATTACHMENTS
  const maxFileMb = useAttachmentStore((s) => s.maxFileMb)
  const addFiles = useAttachmentStore((s) => s.addFiles)
  const workspaceId = useWorkspaceId()
  const removeAttachment = useAttachmentStore((s) => s.remove)
  const clearAttachments = useAttachmentStore((s) => s.clear)
  const attachmentIds = sendableAttachmentIds(attachments)
  const stop = useChatStop(conversationId, session)
  const canSend = !sending && attachmentIds !== null && (Boolean(value.trim()) || attachmentIds.length > 0)

  useEffect(() => {
    void useAttachmentStore.getState().loadSettings(workspaceId)
  }, [workspaceId])

  const suggestions = useMemo(
    () => (mention ? filterMentionTargets(members, mention.query).slice(0, 6) : []),
    [mention, members],
  )

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`
  }, [value])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [conversationId])

  const contextFocus = context?.focusKey
  useEffect(() => {
    if (contextFocus !== undefined) textareaRef.current?.focus()
  }, [contextFocus])

  const setValue = (next: string) => setDrafts((d) => ({ ...d, [conversationId]: next }))

  const updateMention = (text: string, caret: number) => {
    const query = activeMentionQuery(text, caret)
    setMention(query)
    setActive(0)
  }

  const pick = (bot: Bot) => {
    if (!mention) return
    const next = insertMention(value, mention, bot.name)
    setValue(next.text)
    setMention(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      el?.focus()
      el?.setSelectionRange(next.caret, next.caret)
    })
  }

  const submit = async () => {
    const typed = value.trim()
    if (!canSend || !attachmentIds) return
    const content = context && typed ? `${context.prefix}\n${typed}` : typed
    setSending(true)
    setError(false)
    try {
      await send(conversationId, content, attachmentIds)
      if (typed) context?.onClear()
      setValue('')
      clearAttachments(conversationId)
      setMention(null)
    } catch {
      setError(true)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + delta + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const bot = suggestions[active]
        if (bot) pick(bot)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
    }
    if (event.key === 'Escape' && stop.canStop && !value.trim() && attachments.length === 0) {
      event.preventDefault()
      void stop.run()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (!files.length) return
    event.preventDefault()
    const now = new Date()
    addFiles(
      workspaceId,
      conversationId,
      files.map((file) =>
        file.type.startsWith('image/') && (!file.name || /^image\.\w+$/.test(file.name))
          ? new File([file], pastedFileName(file.type, now, t('chat.attachments.pastedPrefix')), {
              type: file.type,
            })
          : file,
      ),
    )
  }

  const listId = `mentions-${conversationId}`

  return (
    <div className={cn('shrink-0', wide ? 'px-5 pb-5' : 'px-3.5 pb-3.5')}>
      <div className="relative mx-auto w-full max-w-[816px]">
        {suggestions.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('chat.mentionList')}
            className="absolute bottom-full left-0 z-popup mb-2 flex w-[280px] flex-col rounded-[10px] border border-border bg-surface-2 p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          >
            {suggestions.map((bot, index) => (
              <li
                key={bot.id}
                id={`${listId}-${bot.id}`}
                role="option"
                aria-selected={index === active}
                onPointerDown={(e) => {
                  e.preventDefault()
                  pick(bot)
                }}
                onPointerEnter={() => setActive(index)}
                className={cn(
                  'flex h-[34px] items-center gap-2.5 rounded-md px-2',
                  index === active && 'bg-accent-soft',
                )}
              >
                <BotAvatar avatar={bot.avatar} state={bot.status} size={20} />
                <span className="text-base font-semibold text-fg">{bot.name}</span>
                {bot.label && <span className="truncate text-sm text-fg-muted">{bot.label}</span>}
              </li>
            ))}
          </ul>
        )}
        {error && <div className="mb-2 text-sm leading-4 text-danger">{t('chat.sendFailed')}</div>}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-3 focus-within:border-accent">
          {context && (
            <FrameChip
              label={context.label}
              className="max-w-full self-start"
              removeLabel={context.removeLabel}
              onRemove={() => {
                context.onClear()
                textareaRef.current?.focus()
              }}
            />
          )}
          {attachments.length > 0 && (
            <ComposerAttachments
              items={attachments}
              maxFileMb={maxFileMb}
              onRemove={(key) => removeAttachment(workspaceId, conversationId, key)}
            />
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            aria-label={t('chat.composerLabel', { name: targetName })}
            aria-autocomplete="list"
            aria-controls={suggestions.length > 0 ? listId : undefined}
            aria-activedescendant={suggestions[active] ? `${listId}-${suggestions[active].id}` : undefined}
            onChange={(e) => {
              setValue(e.target.value)
              updateMention(e.target.value, e.target.selectionStart)
            }}
            onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={() => setMention(null)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder ?? t('chat.composerPlaceholder', { name: targetName })}
            className="selectable resize-none bg-transparent text-md leading-[1.5] text-fg outline-none placeholder:text-fg-muted"
          />
          <div className="flex items-center justify-between">
            <Tooltip content={t('chat.attach')}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label={t('chat.attach')}
                className="focus-ring rounded p-0.5 text-fg-muted hover:text-fg"
              >
                <Paperclip size={15} />
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                if (files.length) addFiles(workspaceId, conversationId, files)
                textareaRef.current?.focus()
              }}
            />
            <div className="flex items-center gap-2">
              {stop.visible && (
                <Tooltip content={stop.stopping ? null : t('chat.stopTooltip', { label: stop.label })}>
                  <button
                    type="button"
                    onClick={() => void stop.run()}
                    disabled={stop.stopping}
                    aria-label={stop.stopping ? t('chat.stopping') : stop.label}
                    className="focus-ring flex h-[30px] items-center gap-1.5 rounded-lg border border-danger-soft px-2.5 text-sm font-semibold text-danger transition hover:bg-danger/5 disabled:opacity-60"
                  >
                    {stop.stopping ? (
                      <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Square size={11} fill="currentColor" strokeWidth={0} />
                    )}
                    {stop.stopping ? t('chat.stopping') : t('chat.stop')}
                  </button>
                </Tooltip>
              )}
              <Tooltip content={t('chat.send')}>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSend}
                  aria-label={t('chat.send')}
                  className="focus-ring flex size-[30px] items-center justify-center rounded-lg bg-accent text-on-accent transition-opacity disabled:opacity-40"
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
