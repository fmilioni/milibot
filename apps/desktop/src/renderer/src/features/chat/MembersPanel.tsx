import { type Bot, type ConversationSummary, type GroupSettings, groupSettings } from '@milibot/shared'
import { Ellipsis, Minus, Plus, User, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { botStatusLabel } from '@/features/bots/lib/bot-status'
import { STATUS_TEXT_CLASS } from '@/features/chat/lib/conversation'
import { RightPanelHeader } from '@/features/workspace/RightPanelHeader'
import { useAppStore, useSelectedConversation } from '@/features/workspace/store'
import { useDraft } from '@/hooks/use-draft'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Menu, type MenuEntry } from '@/ui/Menu'
import { Modal } from '@/ui/Modal'
import { Switch } from '@/ui/Switch'
import { Tooltip } from '@/ui/Tooltip'

const MAX_BOT_MESSAGES = 50

export function MembersPanel() {
  const { t } = useTranslation()
  const conversation = useSelectedConversation()
  if (conversation?.type !== 'group') {
    return (
      <>
        <RightPanelHeader variant="bar" title={t('panels.members.behavior')} />
        <div className="flex flex-1 items-center justify-center p-10 text-center text-base text-fg-muted">
          {t('panels.members.noGroup')}
        </div>
      </>
    )
  }
  return <GroupMembers key={conversation.id} group={conversation} />
}

function GroupMembers({ group }: { group: ConversationSummary }) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const statusDetail = useAppStore((s) => s.statusDetail)
  const addMember = useAppStore((s) => s.addGroupMember)
  const updateSettings = useAppStore((s) => s.updateGroupSettings)
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  const [memberMenu, setMemberMenu] = useState<{ bot: Bot; x: number; y: number } | null>(null)
  const [removing, setRemoving] = useState<Bot | null>(null)
  const members = group.memberBotIds.flatMap((id) => bots[id] ?? [])
  const outside = Object.values(bots).filter((b) => !group.memberBotIds.includes(b.id))
  const settings = groupSettings(group)
  const update = (patch: Partial<GroupSettings>) => void updateSettings(group.id, patch)

  const pickerEntries: MenuEntry[] = outside.length
    ? outside.map((bot) => ({
        key: bot.id,
        label: bot.label ? `${bot.name} · ${bot.label}` : bot.name,
        icon: <BotAvatar avatar={bot.avatar} size={16} animated={false} />,
        onSelect: () => void addMember(group.id, bot.id),
      }))
    : [{ key: 'none', label: t('panels.members.allIn'), disabled: true }]

  return (
    <>
      <RightPanelHeader
        title={t('panels.members.title', { count: members.length + 1 })}
        actions={
          <Button
            size="sm"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setPicker({ x: rect.right - 230, y: rect.bottom + 4 })
            }}
            aria-haspopup="menu"
          >
            <UserPlus size={13} />
            {t('panels.members.add')}
          </Button>
        }
      />
      <div className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        <ul className="flex flex-col gap-1">
          <li className="flex items-center gap-3 rounded-lg px-1.5 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-secondary">
              <User size={14} />
            </span>
            <span className="text-base font-semibold text-fg">{t('panels.members.you')}</span>
          </li>
          {members.map((bot) => (
            <li key={bot.id} className="group flex items-center gap-3 rounded-lg px-1.5 py-2">
              <BotAvatar avatar={bot.avatar} state={bot.status} size={28} className="shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-base font-semibold text-fg">
                  {bot.label ? `${bot.name} · ${bot.label}` : bot.name}
                </span>
                <span className={cn('truncate text-sm', STATUS_TEXT_CLASS[bot.status] ?? 'text-fg-muted')}>
                  {botStatusLabel(bot.status, statusDetail[bot.id], t, bots)}
                </span>
              </div>
              <Tooltip content={t('panels.members.options', { name: bot.name })}>
                <button
                  type="button"
                  aria-label={t('panels.members.options', { name: bot.name })}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    setMemberMenu({ bot, x: rect.right - 200, y: rect.bottom + 4 })
                  }}
                  className="focus-ring shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg"
                >
                  <Ellipsis size={15} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>

        <div className="my-4 h-px shrink-0 bg-border" />
        <span className="mb-3 text-xs font-semibold tracking-[0.06em] text-fg-muted uppercase">
          {t('panels.members.behavior')}
        </span>
        <div className="flex flex-col gap-4">
          <SettingRow
            label={t('panels.members.respondWithoutMention')}
            hint={t('panels.members.respondWithoutMentionHint')}
          >
            <Switch
              checked={settings.respondWithoutMention}
              label={t('panels.members.respondWithoutMention')}
              onChange={(respondWithoutMention) => update({ respondWithoutMention })}
            />
          </SettingRow>
          <SettingRow
            label={t('panels.members.botsCanManage')}
            hint={
              settings.confirmRemovals
                ? t('panels.members.botsCanManageHint')
                : t('panels.members.botsCanManageHintNoConfirm')
            }
          >
            <Switch
              checked={settings.botsCanManageMembers}
              label={t('panels.members.botsCanManage')}
              onChange={(botsCanManageMembers) => update({ botsCanManageMembers })}
            />
          </SettingRow>
          <SettingRow label={t('panels.members.confirmRemovals')}>
            <Switch
              checked={settings.confirmRemovals}
              label={t('panels.members.confirmRemovals')}
              onChange={(confirmRemovals) => update({ confirmRemovals })}
            />
          </SettingRow>
          <SettingRow
            label={t('panels.members.maxBotMessages')}
            hint={t('panels.members.maxBotMessagesHint')}
          >
            <Stepper
              value={settings.maxConsecutiveBotMessages}
              label={t('panels.members.maxBotMessages')}
              onChange={(maxConsecutiveBotMessages) => update({ maxConsecutiveBotMessages })}
            />
          </SettingRow>
        </div>
      </div>

      {picker && (
        <Menu
          entries={pickerEntries}
          x={picker.x}
          y={picker.y}
          label={t('panels.members.addTitle')}
          onClose={() => setPicker(null)}
        />
      )}
      {memberMenu && (
        <Menu
          entries={[
            {
              key: 'remove',
              label: members.length <= 1 ? t('panels.members.lastMember') : t('panels.members.remove'),
              danger: true,
              disabled: members.length <= 1,
              onSelect: () => setRemoving(memberMenu.bot),
            },
          ]}
          x={memberMenu.x}
          y={memberMenu.y}
          width={200}
          label={t('panels.members.options', { name: memberMenu.bot.name })}
          onClose={() => setMemberMenu(null)}
        />
      )}
      {removing && <RemoveMemberModal group={group} bot={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base text-fg">{label}</span>
        {hint && <span className="text-xs leading-[15px] text-fg-muted">{hint}</span>}
      </span>
      {children}
    </div>
  )
}

function Stepper({
  value,
  label,
  onChange,
}: {
  value: number
  label: string
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useDraft(value, String)
  const commit = (next: number) => {
    const clamped = Math.max(1, Math.min(MAX_BOT_MESSAGES, Math.round(next)))
    setDraft(String(clamped))
    if (clamped !== value) onChange(clamped)
  }
  const stepClass =
    'focus-ring flex size-6 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 disabled:opacity-40'
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-3 p-0.5"
      role="group"
      aria-label={label}
    >
      <button type="button" className={stepClass} disabled={value <= 1} onClick={() => commit(value - 1)}>
        <Minus size={12} />
      </button>
      <input
        value={draft}
        inputMode="numeric"
        aria-label={label}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={() => commit(Number(draft) || value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="selectable w-7 bg-transparent text-center text-base font-semibold text-fg outline-none"
      />
      <button
        type="button"
        className={stepClass}
        disabled={value >= MAX_BOT_MESSAGES}
        onClick={() => commit(value + 1)}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

function RemoveMemberModal({
  group,
  bot,
  onClose,
}: {
  group: ConversationSummary
  bot: Bot
  onClose: () => void
}) {
  const { t } = useTranslation()
  const removeMember = useAppStore((s) => s.removeGroupMember)
  return (
    <Modal
      title={t('panels.members.removeTitle', { name: bot.name })}
      description={t('panels.members.removeBody', { name: bot.name })}
      width={420}
      onClose={onClose}
    >
      <div className="flex justify-end gap-2.5">
        <Button onClick={onClose} data-autofocus>
          {t('common.cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose()
            void removeMember(group.id, bot.id)
          }}
        >
          {t('panels.members.removeConfirm')}
        </Button>
      </div>
    </Modal>
  )
}
