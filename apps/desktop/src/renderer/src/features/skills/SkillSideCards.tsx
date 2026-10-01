import type { SkillDetail, SkillUsage } from '@milibot/shared'
import { File, FileCode, FileText, Folder } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fileTree, originLines } from '@/features/skills/lib/skills'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { botNames, botOptions } from '@/lib/select-options'
import { MultiSelect } from '@/ui/MultiSelect'

import { useSkillsStore } from './store'

const FILES_SHOWN = 8

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <h2 className="text-xs font-semibold tracking-[0.02em] text-fg-muted uppercase">{title}</h2>
      {children}
    </section>
  )
}

function fileIcon(name: string, folder: boolean) {
  if (folder) return <Folder size={12} className="shrink-0 text-fg-muted" aria-hidden />
  if (/\.(md|txt)$/i.test(name)) return <FileText size={12} className="shrink-0 text-fg-muted" aria-hidden />
  if (/\.(sh|py|js|mjs|ts|rb|pl|php)$/i.test(name))
    return <FileCode size={12} className="shrink-0 text-fg-muted" aria-hidden />
  return <File size={12} className="shrink-0 text-fg-muted" aria-hidden />
}

/** The skill page's side column: who can use it, its files, where it came from and how much it is used. */
export function SkillSideCards({
  skill,
  detail,
  usage,
}: {
  skill: SkillDetail
  detail: SkillDetail
  usage: SkillUsage | null
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const workspaces = useAppStore((s) => s.workspaces)
  const update = useSkillsStore((s) => s.update)
  const [allFiles, setAllFiles] = useState(false)
  const tree = fileTree(detail.files)
  const shownFiles = allFiles ? tree : tree.slice(0, FILES_SHOWN)
  const names = (ids: string[]) => botNames(ids, bots)
  const accessHint =
    skill.defaultFor === 'first'
      ? skill.enabledFor.length
        ? t('skills.detail.onlyFor', { names: names(skill.enabledFor) })
        : t('skills.detail.onlyForNone')
      : skill.disabledFor.length
        ? t('skills.detail.disabledFor', { names: names(skill.disabledFor) })
        : null

  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-3.5">
      <SideCard title={t('skills.detail.whoCanUse')}>
        {skill.source === 'taught' ? (
          <span className="text-sm text-fg">
            {skill.allowedBots === 'all'
              ? t('skills.access.allChip')
              : t('skills.access.only', { name: names(skill.allowedBots) || '…' })}
          </span>
        ) : (
          <MultiSelect
            value={skill.allowedBots}
            onChange={(allowedBots) => void toastOnError(update(workspaceId, skill.id, { allowedBots }))}
            label={t('skills.detail.whoCanUse')}
            allLabel={t('skills.access.allChip')}
            placeholder={t('skills.access.none')}
            options={botOptions(bots)}
            tone="surface-2"
            className="h-[29px]! text-sm! font-semibold"
          />
        )}
        {accessHint && <span className="text-xs leading-[15px] text-fg-muted">{accessHint}</span>}
      </SideCard>
      {(skill.source !== 'taught' || detail.files.length > 0) && (
        <SideCard
          title={
            skill.source === 'taught'
              ? t('skills.meta.captures', { count: detail.files.length })
              : t('skills.detail.files', { count: detail.files.length })
          }
        >
          <ul className="flex flex-col gap-2">
            {shownFiles.map((row) => (
              <li
                key={`${row.folder ? 'd' : 'f'}:${row.path}`}
                className="flex min-w-0 items-center gap-1.5"
                style={{ paddingLeft: row.depth * 16 }}
              >
                {fileIcon(row.name, row.folder)}
                <span className="selectable truncate font-mono text-xs text-fg">{row.name}</span>
              </li>
            ))}
            {tree.length > FILES_SHOWN && (
              <li>
                <button
                  type="button"
                  onClick={() => setAllFiles(!allFiles)}
                  className="focus-ring rounded pl-4 font-mono text-xs text-fg-muted hover:text-fg-secondary hover:underline"
                >
                  {allFiles
                    ? t('skills.detail.fewerFiles')
                    : t('skills.detail.moreFiles', { count: tree.length - FILES_SHOWN })}
                </button>
              </li>
            )}
          </ul>
        </SideCard>
      )}
      <SideCard title={t('skills.detail.origin.title')}>
        {originLines(skill, { bots, workspaces, t, locale: i18n.language }).map((line, index) => (
          <span
            key={index}
            className={line.mono ? 'selectable font-mono text-sm break-all text-fg' : 'text-sm text-fg'}
          >
            {line.text}
          </span>
        ))}
      </SideCard>
      <SideCard title={t('skills.detail.usage')}>
        <span className="text-sm text-fg">
          {usage === null
            ? '…'
            : usage.loads === 0
              ? t('skills.detail.usageNone', { days: usage.days })
              : t('skills.detail.usageText', {
                  count: usage.loads,
                  days: usage.days,
                  names: names(usage.bots.map((b) => b.botId)) || '…',
                })}
        </span>
        <span className="selectable font-mono text-xs [overflow-wrap:anywhere] text-fg-muted">
          {detail.vmPath ? t('skills.detail.vmPath', { path: detail.vmPath }) : t('skills.detail.noVm')}
        </span>
      </SideCard>
    </aside>
  )
}
