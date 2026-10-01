import type { Bot, SkillCreatedPayload } from '@milibot/shared'
import { ChevronRight, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSkillsStore } from '@/features/skills/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Button, LinkButton } from '@/ui/Button'
import { Tooltip } from '@/ui/Tooltip'

/** "Skill created · <name>" after `skill_save`, with "Share with all" while only its author has it. */
function SkillCreatedCard({
  payload,
  bots,
  shared,
  onShare,
  onOpen,
}: {
  payload: SkillCreatedPayload
  bots: Record<string, Bot>
  /** Every bot may use it now (it may have changed since the card was posted). */
  shared: boolean
  onShare?: () => Promise<void>
  onOpen?: () => void
}) {
  const { t } = useTranslation()
  const [sharing, setSharing] = useState(false)
  const scope = shared
    ? t('chat.skill.allBots')
    : t('chat.skill.onlyBot', { name: bots[payload.botId]?.name ?? '…' })
  const sub = [payload.description, t('chat.skill.files', { count: payload.files }), scope]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-border bg-surface px-3 py-2.5">
      <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Sparkles size={14} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-base font-semibold text-fg">
          {t(payload.updated ? 'chat.skill.updated' : 'chat.skill.created', { name: payload.name })}
        </span>
        <Tooltip content={sub} maxWidth={420}>
          <span className="truncate text-sm text-fg-secondary">{sub}</span>
        </Tooltip>
      </div>
      {!shared && onShare && (
        <Button
          size="sm"
          variant="outline"
          className="bg-transparent"
          disabled={sharing}
          onClick={() => {
            setSharing(true)
            void onShare().finally(() => setSharing(false))
          }}
        >
          {t('chat.skill.share')}
        </Button>
      )}
      {onOpen && (
        <LinkButton onClick={onOpen} className="flex items-center gap-1">
          {t('chat.skill.open')}
          <ChevronRight size={13} aria-hidden />
        </LinkButton>
      )}
    </div>
  )
}

/** The skill card with its live access: "Share with all" goes away once every bot may use it. */
export function SkillCreatedEntry({
  payload,
  bots,
}: {
  payload: SkillCreatedPayload
  bots: Record<string, Bot>
}) {
  const workspaceId = useWorkspaceId()
  const current = useSkillsStore((s) =>
    s.workspaceId === workspaceId ? s.skills.find((k) => k.id === payload.skillId) : undefined,
  )
  const [shared, setShared] = useState(false)
  const everyone = shared || (current ? current.allowedBots === 'all' : payload.scope === 'all')
  return (
    <SkillCreatedCard
      payload={payload}
      bots={bots}
      shared={everyone}
      onShare={async () => {
        await toastOnError(
          useSkillsStore
            .getState()
            .update(workspaceId, payload.skillId, { allowedBots: 'all' })
            .then(() => {
              setShared(true)
              useAppStore.getState().showToast('skillShared')
            }),
        )
      }}
      onOpen={() => useSkillsStore.getState().openSkill(payload.skillId)}
    />
  )
}
