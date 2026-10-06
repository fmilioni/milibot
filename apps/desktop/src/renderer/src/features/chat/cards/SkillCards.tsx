import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatBytes } from '@/lib/format'

/** The `details` param of a `skill_import` confirmation (JSON written by the daemon's `SkillAdmin`). */
interface SkillImportDetailsJson {
  source?: { kind: 'github'; repo: string; ref: string; sha: string } | { kind: 'zip'; path: string }
  skills?: Array<{
    name: string
    importAs: string
    description: string
    files: number
    bytes: number
    conflict: string
    hasScripts: boolean
    declaredTools?: string[]
  }>
  bots?: string[] | 'all'
  families?: string[]
}

/** The `details` param of a `bot_skills` confirmation. */
interface BotSkillsDetailsJson {
  changes?: Array<{ skill: string; on: boolean; families: string[]; tools: number; allow: boolean }>
}

export function parseCardDetails<T>(json: string): T | null {
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}

/** Whether an import card brings files the bots can run (the card then asks with the danger style). */
export function importHasScripts(details: string | undefined): boolean {
  const parsed = details ? parseCardDetails<SkillImportDetailsJson>(details) : null
  return !!parsed?.skills?.some((s) => s.hasScripts)
}

function Warning({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-warning">
      <TriangleAlert size={13} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
}

/** What a skill import asks the user to approve: the pinned source, each skill and the tools it unlocks (none). */
export function SkillImportDetails({ details }: { details: string }) {
  const { t, i18n } = useTranslation()
  const parsed = parseCardDetails<SkillImportDetailsJson>(details)
  if (!parsed?.source || !Array.isArray(parsed.skills)) return null
  const source =
    parsed.source.kind === 'github'
      ? t('chat.confirmation.skills.githubSource', {
          repo: parsed.source.repo,
          sha: parsed.source.sha.slice(0, 7),
          ref: parsed.source.ref,
        })
      : parsed.source.path
  const declared = [...new Set(parsed.skills.flatMap((s) => s.declaredTools ?? []))]
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-3 px-3 py-2 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-fg-muted">{t('chat.confirmation.skills.source')}</dt>
        <dd className="min-w-0 font-mono break-all text-fg-secondary">{source}</dd>
        <dt className="text-fg-muted">{t('chat.confirmation.skills.bots')}</dt>
        <dd className="min-w-0 text-fg-secondary">
          {parsed.bots === 'all' || !parsed.bots
            ? t('chat.confirmation.skills.allBots')
            : parsed.bots.join(', ')}
        </dd>
        <dt className="text-fg-muted">{t('chat.confirmation.skills.unlocks')}</dt>
        <dd className="min-w-0 text-fg-secondary">
          {parsed.families?.length ? parsed.families.join(', ') : t('chat.confirmation.skills.none')}
        </dd>
      </dl>
      <ul className="flex flex-col gap-2">
        {parsed.skills.map((skill) => (
          <li key={skill.importAs} className="flex flex-col gap-0.5">
            <span className="font-semibold text-fg">{skill.name}</span>
            {skill.description && <span className="text-fg-secondary">{skill.description}</span>}
            <span className="text-fg-muted">
              {t('chat.confirmation.skills.files', {
                count: skill.files,
                size: formatBytes(skill.bytes, i18n.language),
              })}
              {skill.conflict === 'update' && ` · ${t('chat.confirmation.skills.update')}`}
              {skill.importAs !== skill.name &&
                ` · ${t('chat.confirmation.skills.renamed', { name: skill.importAs })}`}
            </span>
            {skill.hasScripts && <Warning text={t('chat.confirmation.skills.scripts')} />}
          </li>
        ))}
      </ul>
      {declared.length > 0 && (
        <Warning text={t('chat.confirmation.skills.declared', { families: declared.join(', ') })} />
      )}
    </div>
  )
}

/** What a change of a bot's skills asks to approve: each switch and the tool families it unlocks. */
export function BotSkillsDetails({ details, botName }: { details: string; botName: string }) {
  const { t } = useTranslation()
  const parsed = parseCardDetails<BotSkillsDetailsJson>(details)
  if (!Array.isArray(parsed?.changes) || parsed.changes.length === 0) return null
  return (
    <ul className="flex flex-col gap-2 rounded-lg bg-surface-3 px-3 py-2 text-sm">
      {parsed.changes.map((change) => (
        <li key={change.skill} className="flex flex-col gap-0.5">
          <span className="text-fg">
            <span className="text-fg-muted">
              {t(change.on ? 'chat.confirmation.skills.on' : 'chat.confirmation.skills.off')}
            </span>{' '}
            <span className="font-semibold">{change.skill}</span>
          </span>
          <span className="text-fg-secondary">
            {change.families.length
              ? t('chat.confirmation.skills.families', {
                  count: change.tools,
                  families: change.families.join(', '),
                })
              : t('chat.confirmation.skills.noFamilies')}
          </span>
          {change.allow && <Warning text={t('chat.confirmation.skills.allow', { botName })} />}
        </li>
      ))}
    </ul>
  )
}
