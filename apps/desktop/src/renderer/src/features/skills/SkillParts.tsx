import type { Skill, SkillErrorCode, SkillErrorParams } from '@milibot/shared'
import {
  BookOpen,
  Bot as BotIcon,
  CalendarClock,
  CircleArrowUp,
  ClipboardList,
  FileArchive,
  FileText,
  Folder,
  FolderKanban,
  GitBranch,
  Globe,
  GraduationCap,
  KeyRound,
  Layers,
  type LucideIcon,
  Monitor,
  PenTool,
  Presentation,
  Sparkles,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { createElement } from 'react'
import { useTranslation } from 'react-i18next'

import { type SkillChip, skillErrorKey } from '@/features/skills/lib/skills'
import { cn } from '@/lib/cn'
import { Tag } from '@/ui/Tag'

/** The GitHub mark (lucide dropped brand icons). */
export function GithubMark({ size = 11, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  'web-browsing': Globe,
  'using-the-screen': Monitor,
  'code-and-repos': GitBranch,
  'team-management': Users,
  projects: FolderKanban,
  'plans-and-sessions': ClipboardList,
  'knowledge-base': BookOpen,
  routines: CalendarClock,
  'secrets-and-variables': KeyRound,
  'skill-creator': Sparkles,
  design: PenTool,
  slides: Presentation,
}

export function skillIcon(skill: Pick<Skill, 'slug' | 'source' | 'error'>): LucideIcon {
  if (skill.error) return TriangleAlert
  if (skill.source === 'taught') return GraduationCap
  if (skill.source === 'builtin') return BUILTIN_ICONS[skill.slug] ?? Sparkles
  return FileText
}

/** Rounded square with the skill's icon (danger tint for an invalid SKILL.md). */
export function SkillIconBox({ skill, size = 32 }: { skill: Skill; size?: number }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center',
        size > 34 ? 'rounded-[10px]' : 'rounded-lg',
        skill.error ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-fg',
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {createElement(skillIcon(skill), { size: size > 34 ? 18 : 15 })}
    </span>
  )
}

export function SourceChip({ chip }: { chip: SkillChip }) {
  const { t } = useTranslation()
  switch (chip.kind) {
    case 'github':
      return <Tag icon={<GithubMark />}>{chip.label}</Tag>
    case 'folder':
      return <Tag icon={<Folder size={11} aria-hidden />}>{t('skills.chips.folder')}</Tag>
    case 'zip':
      return <Tag icon={<FileArchive size={11} aria-hidden />}>{t('skills.chips.zip')}</Tag>
    case 'workspace':
      return <Tag icon={<Layers size={11} aria-hidden />}>{t('skills.chips.workspace')}</Tag>
    case 'bot':
      return (
        <Tag icon={<BotIcon size={11} aria-hidden />}>{t('skills.chips.createdBy', { name: chip.name })}</Tag>
      )
    case 'update':
      return (
        <Tag tone="accent" icon={<CircleArrowUp size={11} aria-hidden />}>
          {t('skills.chips.update')}
        </Tag>
      )
  }
}

/** Name and description shown for a skill: built-ins get a translated name and description. */
export function useSkillText() {
  const { t } = useTranslation()
  return (skill: Pick<Skill, 'slug' | 'name' | 'description' | 'source'>) =>
    skill.source === 'builtin'
      ? {
          name: t(`skills.builtin.${skill.slug}.name` as never, { defaultValue: skill.slug }),
          description: t(`skills.builtin.${skill.slug}.description` as never, {
            defaultValue: skill.description,
          }),
        }
      : { name: skill.name, description: skill.description }
}

/** Localized error of a skill: by its code when the daemon sent one, else by the English message. */
export function useSkillError() {
  const { t } = useTranslation()
  return (error: string, code?: SkillErrorCode | null, params?: SkillErrorParams | null): string => {
    if (code) return String(t(`skills.errors.codes.${code}` as never, params ?? {}))
    const key = skillErrorKey(error)
    return key ? t(key as never) : error
  }
}
