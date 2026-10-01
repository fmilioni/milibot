import type { Bot, PromptVersion } from '@milibot/shared'
import { ChevronRight, Plus, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import {
  createBotMemory,
  deleteBotMemory,
  restorePromptVersion,
  updateBotMemory,
  useBotMemories,
  usePromptVersions,
} from '@/features/bots/api'
import { NoteEditor } from '@/features/memory/NoteEditor'
import { NoteItem } from '@/features/memory/NoteItem'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { cn } from '@/lib/cn'
import { DiffStat } from '@/ui/diff/DiffStat'
import { DiffView } from '@/ui/diff/DiffView'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

/** "Memory" of the bot settings: the bot's notes and the versions of its prompt. */
export function BotMemorySection({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const openSettings = useAppStore((s) => s.openSettings)
  const { data: notes } = useBotMemories(workspaceId, bot.id)
  const [adding, setAdding] = useState(false)
  const ws = workspaceId ?? ''
  const { run } = useApiMutation(
    async (action: () => Promise<unknown>) => {
      await action()
    },
    {
      invalidates: [queryKeys.botMemories(ws, bot.id)],
    },
  )

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-secondary">{t('memory.bot.title')}</h3>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="focus-ring flex items-center gap-1 rounded text-sm font-medium text-accent hover:underline"
          >
            <Plus size={12} />
            {t('memory.add')}
          </button>
        )}
      </div>
      {adding && (
        <NoteEditor
          initial=""
          placeholder={t('memory.bot.placeholder', { name: bot.name })}
          onCancel={() => setAdding(false)}
          onSave={(content) => run(() => createBotMemory(ws, bot.id, content)).then(() => setAdding(false))}
        />
      )}
      {notes === null ? (
        <Spinner className="text-fg-muted" />
      ) : notes.length === 0 ? (
        !adding && <span className="text-sm text-fg-muted">{t('memory.bot.empty', { name: bot.name })}</span>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              pinnable
              onPin={(pinned) => run(() => updateBotMemory(ws, bot.id, note.id, { pinned }))}
              onSave={(content) => run(() => updateBotMemory(ws, bot.id, note.id, { content }))}
              onDelete={() => run(() => deleteBotMemory(ws, bot.id, note.id))}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => openSettings('memory')}
        className="focus-ring w-fit rounded text-left text-xs text-fg-muted hover:text-fg hover:underline"
      >
        {t('memory.bot.workspaceLink')}
      </button>
      <PromptVersions bot={bot} />
    </section>
  )
}

function PromptVersions({ bot }: { bot: Bot }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId) ?? ''
  const bots = useAppStore((s) => s.bots)
  const { data: versions } = usePromptVersions(workspaceId, bot.id)
  const restoreMutation = useApiMutation(
    (versionId: string) => restorePromptVersion(workspaceId, bot.id, versionId),
    { invalidates: [queryKeys.promptVersions(workspaceId, bot.id)] },
  )
  const [open, setOpen] = useState<string | null>(null)
  const date = new Intl.DateTimeFormat(i18n.language, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const author = (v: PromptVersion) =>
    v.authorType === 'system'
      ? t('memory.versions.initial')
      : v.authorType === 'user'
        ? t('memory.versions.byUser')
        : (bots[v.authorBotId ?? '']?.name ?? '…')
  const restore = (v: PromptVersion) => restoreMutation.run(v.id)
  return (
    <div className="flex flex-col gap-2 pt-1.5">
      <h4 className="text-sm font-medium text-fg-secondary">{t('memory.versions.title')}</h4>
      {versions === null ? (
        <Spinner className="text-fg-muted" />
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
          {versions.map((v) => {
            const expanded = open === v.id
            return (
              <li key={v.id} className="flex flex-col border-b border-border bg-surface-2 last:border-0">
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : v.id)}
                    className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
                  >
                    <ChevronRight
                      size={12}
                      className={cn(
                        'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
                        expanded && 'rotate-90',
                      )}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 text-sm text-fg">
                        <span className="truncate font-medium">{author(v)}</span>
                        <span className="shrink-0 text-xs text-fg-muted">{date.format(v.createdAt)}</span>
                        {v.current && (
                          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-2xs font-semibold text-accent">
                            {t('memory.versions.current')}
                          </span>
                        )}
                      </span>
                      {v.reason && <span className="truncate text-xs text-fg-muted">{v.reason}</span>}
                    </span>
                  </button>
                  {v.authorType !== 'system' && <DiffStat added={v.added} removed={v.removed} strong />}
                  {!v.current && (
                    <Tooltip content={t('memory.versions.restoreHint')}>
                      <button
                        type="button"
                        onClick={() => void restore(v)}
                        className="focus-ring flex shrink-0 items-center gap-1 rounded text-xs font-semibold text-accent hover:underline"
                      >
                        <RotateCcw size={11} />
                        {t('memory.versions.restore')}
                      </button>
                    </Tooltip>
                  )}
                </div>
                {expanded && (
                  <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
                    {v.diff ? (
                      <DiffView diff={v.diff} />
                    ) : (
                      <pre className="selectable scroll-slim max-h-72 overflow-auto rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs leading-[17px] whitespace-pre-wrap text-fg-secondary">
                        {v.text || t('memory.versions.empty')}
                      </pre>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
