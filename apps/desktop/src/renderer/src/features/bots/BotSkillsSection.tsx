import type { Bot, BotSkill } from '@milibot/shared'
import { Bot as BotIcon, Lock } from 'lucide-react'
import { createElement, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { groupSkills, skillOrigin } from '@/features/skills/lib/skills'
import { GithubMark, skillIcon, useSkillText } from '@/features/skills/SkillParts'
import { useSkillsStore } from '@/features/skills/store'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { Tag } from '@/ui/Tag'
import { Tooltip } from '@/ui/Tooltip'

import { SmallSwitch } from './BotMcpSection'

const BUILTINS_SHOWN = 4

function Row({ item, bot, onChange }: { item: BotSkill; bot: Bot; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation()
  const text = useSkillText()
  const { skill } = item
  const { name } = text(skill)
  const on = item.active
  const origin = skillOrigin(skill)
  let chip: React.ReactNode = null
  if (!item.allowed)
    chip = (
      <Tooltip content={t('panels.bot.skills.notAllowedHint')}>
        <span>
          <Tag size="sm" icon={<Lock size={10} aria-hidden />}>
            {t('panels.bot.skills.notAllowed')}
          </Tag>
        </span>
      </Tooltip>
    )
  else if (!skill.enabled) chip = <Tag size="sm">{t('panels.bot.skills.offInWorkspace')}</Tag>
  else if (skill.source === 'import' && origin?.kind === 'github')
    chip = (
      <Tag size="sm" icon={<GithubMark size={10} />}>
        GitHub
      </Tag>
    )
  else if (skill.source === 'bot' && skill.authorBotId === bot.id)
    chip = (
      <Tag size="sm" icon={<BotIcon size={10} aria-hidden />}>
        {t('panels.bot.skills.createdByThis')}
      </Tag>
    )
  else if (skill.source === 'taught') chip = <Tag size="sm">{t('panels.bot.skills.taught')}</Tag>
  else if (skill.source === 'builtin' && on && skill.toolCount > 0)
    chip = <Tag size="sm">{t('skills.meta.tools', { count: skill.toolCount })}</Tag>

  return (
    <li className="flex items-center gap-2.5 px-3 py-[7px]">
      {createElement(skillIcon(skill), {
        size: 14,
        className: `shrink-0 ${on ? 'text-fg' : 'text-fg-muted'}`,
        'aria-hidden': true,
      })}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Tooltip content={text(skill).description || null} maxWidth={360}>
          <span className={cn('truncate text-base', on ? 'text-fg' : 'text-fg-muted')}>{name}</span>
        </Tooltip>
        {chip}
      </span>
      <SmallSwitch
        checked={on}
        disabled={!item.allowed || !skill.enabled}
        label={t('panels.bot.skills.use', { name })}
        onChange={onChange}
      />
    </li>
  )
}

/** "Skills" of the bot settings: the workspace's skills, then the included ones. */
export function BotSkillsSection({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const openSettings = useAppStore((s) => s.openSettings)
  const showToast = useAppStore((s) => s.showToast)
  const items = useSkillsStore((s) => (s.workspaceId === workspaceId ? s.botSkills[bot.id] : undefined))
  const loadBot = useSkillsStore((s) => s.loadBot)
  const updateBotSkill = useSkillsStore((s) => s.updateBotSkill)
  const openSkill = useSkillsStore((s) => s.openSkill)
  const [allBuiltins, setAllBuiltins] = useState(false)

  useEffect(() => {
    void loadBot(workspaceId, bot.id).catch(() => undefined)
  }, [loadBot, workspaceId, bot.id])

  const usable = (items ?? []).filter((i) => !i.skill.error)
  const byId = new Map(usable.map((i) => [i.skill.id, i]))
  const groups = groupSkills(usable.map((i) => i.skill)).map(({ group, skills }) => ({
    group,
    items: skills.map((s) => byId.get(s.id) as BotSkill),
  }))
  const workspace = groups.filter((g) => g.group !== 'builtin').flatMap((g) => g.items)
  const builtins = groups.find((g) => g.group === 'builtin')?.items ?? []
  const shownBuiltins = allBuiltins ? builtins : builtins.slice(0, BUILTINS_SHOWN)
  const change = (skillId: string) => (enabled: boolean) =>
    void updateBotSkill(workspaceId, bot.id, skillId, enabled).catch(() => showToast('error'))

  const header = (label: string) => (
    <li className="px-3 pt-2 pb-1 text-2xs font-semibold tracking-[0.02em] text-fg-muted uppercase">
      {label}
    </li>
  )

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-fg-secondary">{t('panels.bot.skills.title')}</h3>
        <button
          type="button"
          onClick={() => {
            openSkill(null)
            openSettings('skills')
          }}
          className="focus-ring rounded text-sm text-accent hover:underline"
        >
          {t('panels.bot.skills.manage')}
        </button>
      </div>
      {items && (
        <ul className="flex flex-col rounded-[10px] border border-border bg-surface-2 pb-1">
          {workspace.length > 0 && header(t('panels.bot.skills.workspace'))}
          {workspace.map((item) => (
            <Row key={item.skill.id} item={item} bot={bot} onChange={change(item.skill.id)} />
          ))}
          {builtins.length > 0 && header(t('panels.bot.skills.builtin'))}
          {shownBuiltins.map((item) => (
            <Row key={item.skill.id} item={item} bot={bot} onChange={change(item.skill.id)} />
          ))}
          {builtins.length > BUILTINS_SHOWN && (
            <li className="pr-3 pb-1.5 pl-9">
              <button
                type="button"
                aria-expanded={allBuiltins}
                onClick={() => setAllBuiltins(!allBuiltins)}
                className="focus-ring rounded text-xs text-accent hover:underline"
              >
                {allBuiltins
                  ? t('panels.bot.skills.less')
                  : t('panels.bot.skills.more', { count: builtins.length - BUILTINS_SHOWN })}
              </button>
            </li>
          )}
        </ul>
      )}
      <span className="text-xs leading-[14px] text-fg-muted">{t('panels.bot.skills.hint')}</span>
    </section>
  )
}
