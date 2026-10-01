import type { Skill } from '@milibot/shared'
import {
  ChevronDown,
  ChevronUp,
  Download,
  FilePlus,
  Folder,
  FolderOpen,
  FolderSearch,
  Terminal,
  User,
  Users,
  Wrench,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice, SettingsPage } from '@/features/settings/SettingsLayout'
import {
  BUILTINS_SHOWN,
  countByFilter,
  filterSkills,
  groupSkills,
  importablePaths,
  type SkillFilter,
  type SkillGroup,
  type SkillMetaItem,
  skillRowMeta,
  sourceChips,
} from '@/features/skills/lib/skills'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useFileDrop } from '@/hooks/use-file-drop'
import { cn } from '@/lib/cn'
import { shortPath } from '@/lib/platform'
import { Button } from '@/ui/Button'
import { InlineConfirm } from '@/ui/Confirm'
import { DropOverlay } from '@/ui/DropOverlay'
import { MoreMenu } from '@/ui/MoreMenu'
import { Segmented } from '@/ui/Segmented'
import { Switch } from '@/ui/Switch'
import { Tag } from '@/ui/Tag'
import { SearchInput } from '@/ui/TextInput'

import { ImportSkillsDialog } from './ImportSkillsDialog'
import { NewSkillDialog } from './NewSkillDialog'
import { SkillDetailView } from './SkillDetail'
import { SkillIconBox, SourceChip, useSkillError, useSkillText } from './SkillParts'
import { NO_SKILLS, useSkillsStore } from './store'
import { useSkillMenu } from './use-skill-menu'

const FILTERS: SkillFilter[] = ['all', 'yours', 'taught', 'builtin']

const META_ICONS = { tools: Wrench, scripts: Terminal, user: User, users: Users }

/** Paths of files and folders dropped on the window (sandboxed renderer: through the preload). */
function droppedPaths(event: DragEvent): string[] {
  return Array.from(event.dataTransfer?.files ?? []).flatMap((file) => {
    try {
      const path = window.milibot.getPathForFile(file)
      return path ? [path] : []
    } catch {
      return []
    }
  })
}

/** Settings › Skills: the library, its import dialog and one skill opened. */
export function SkillsSettings() {
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const load = useSkillsStore((s) => s.load)
  const loadFolder = useSkillsStore((s) => s.loadFolder)
  const detailId = useSkillsStore((s) => (s.workspaceId === workspaceId ? s.detailId : null))
  const importing = useSkillsStore((s) => (s.workspaceId === workspaceId ? s.importing : null))
  const openImport = useSkillsStore((s) => s.openImport)
  const dragging = useFileDrop((event) => {
    const paths = importablePaths(droppedPaths(event))
    if (paths.length) openImport(paths)
  })
  const { t } = useTranslation()

  useEffect(() => {
    void load(workspaceId).catch(() => showToast('error'))
    void loadFolder(workspaceId).catch(() => undefined)
  }, [load, loadFolder, workspaceId, showToast])

  return (
    <>
      {detailId ? <SkillDetailView key={detailId} skillId={detailId} /> : <SkillsList />}
      {importing && <ImportSkillsDialog initialPaths={importing.paths} />}
      {dragging && !importing && (
        <DropOverlay
          icon={<FolderSearch size={24} />}
          title={t('skills.dropTitle')}
          hint={t('skills.import.drop')}
        />
      )}
    </>
  )
}

function SkillsList() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const skills = useSkillsStore((s) => (s.workspaceId === workspaceId ? s.skills : NO_SKILLS))
  const loaded = useSkillsStore((s) => s.workspaceId === workspaceId && s.loaded)
  const folder = useSkillsStore((s) => (s.workspaceId === workspaceId ? s.folder : null))
  const loadFolder = useSkillsStore((s) => s.loadFolder)
  const openImport = useSkillsStore((s) => s.openImport)
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [allBuiltins, setAllBuiltins] = useState(false)
  const text = useSkillText()
  const counts = countByFilter(skills)
  const groups = groupSkills(filterSkills(skills, filter, query, text))

  const openFolder = async () => {
    const current = folder ?? (await loadFolder(workspaceId))
    await window.milibot.revealPath(current.path)
  }

  return (
    <SettingsPage
      title={t('skills.title')}
      subtitle={t('skills.subtitle')}
      width="wide"
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => void toastOnError(openFolder())}>
            <FolderOpen size={13} className="text-fg-secondary" />
            {t('skills.openFolder')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <FilePlus size={13} className="text-fg-secondary" />
            {t('skills.new')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => openImport()}>
            <Download size={13} />
            {t('skills.import.open')}
          </Button>
        </>
      }
    >
      <div className="flex items-center justify-between gap-4 pt-1 pb-0.5">
        <Segmented
          size="sm"
          role="tab"
          label={t('skills.filterLabel')}
          value={filter}
          options={FILTERS.map((id) => ({ value: id, label: t(`skills.filters.${id}`), count: counts[id] }))}
          onChange={setFilter}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('skills.search')}
          className="w-[240px]"
        />
      </div>
      {groups.map(({ group, skills: members }) => (
        <SkillGroupList
          key={group}
          group={group}
          skills={members}
          expanded={allBuiltins || query.trim() !== ''}
          onExpand={setAllBuiltins}
        />
      ))}
      {loaded && groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-base text-fg-muted">
          {t('skills.empty')}
        </div>
      )}
      <Notice icon={<Folder size={14} className="text-fg-secondary" />}>
        {t('skills.folderNote', {
          path: folder ? shortPath(folder.path) : '…',
          vmPath: folder?.vmPath ?? '/usr/local/share/milibot/skills',
        })}
      </Notice>
      {creating && <NewSkillDialog onClose={() => setCreating(false)} />}
    </SettingsPage>
  )
}

function SkillGroupList({
  group,
  skills,
  expanded,
  onExpand,
}: {
  group: SkillGroup
  skills: Skill[]
  expanded: boolean
  onExpand: (expanded: boolean) => void
}) {
  const { t } = useTranslation()
  const text = useSkillText()
  const collapsible = group === 'builtin' && skills.length > BUILTINS_SHOWN + 1
  const shown = collapsible && !expanded ? skills.slice(0, BUILTINS_SHOWN) : skills
  const hidden = skills.slice(BUILTINS_SHOWN)
  return (
    <section className="flex flex-col gap-2" aria-label={t(`skills.groups.${group}.title`)}>
      <div className="flex items-baseline justify-between gap-4 px-0.5 pt-2.5">
        <h2 className="text-xs font-semibold tracking-[0.02em] text-fg-muted uppercase">
          {t(`skills.groups.${group}.title`)}
        </h2>
        <span className="truncate text-xs text-fg-muted">{t(`skills.groups.${group}.hint`)}</span>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-2">
        {shown.map((skill, index) => (
          <SkillRow key={skill.id} skill={skill} first={index === 0} />
        ))}
        {collapsible && (
          <li>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => onExpand(!expanded)}
              className="focus-ring flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-sm font-semibold text-accent hover:bg-surface-3/40"
            >
              {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
              <span className="truncate">
                {expanded
                  ? t('skills.showLess')
                  : t('skills.showMore', {
                      count: hidden.length,
                      names: hidden.map((s) => text(s).name).join(', '),
                    })}
              </span>
            </button>
          </li>
        )}
      </ul>
    </section>
  )
}

function MetaItem({ item }: { item: SkillMetaItem }) {
  if (item.kind === 'text') return <span>{item.text}</span>
  const Icon = META_ICONS[item.icon]
  return <Tag icon={<Icon size={11} aria-hidden />}>{item.text}</Tag>
}

function SkillRow({ skill, first }: { skill: Skill; first: boolean }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const update = useSkillsStore((s) => s.update)
  const remove = useSkillsStore((s) => s.remove)
  const openSkill = useSkillsStore((s) => s.openSkill)
  const [confirming, setConfirming] = useState(false)
  const text = useSkillText()
  const errorText = useSkillError()
  const { name, description } = text(skill)
  const chips = sourceChips(skill, bots)
  const entries = useSkillMenu(skill, { withOpen: true, onDelete: () => setConfirming(true) })
  const meta = skillRowMeta(skill, bots, { first, t, locale: i18n.language })

  return (
    <li className={cn('flex flex-col', !first && 'border-t border-border')}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <SkillIconBox skill={skill} />
        <button
          type="button"
          onClick={() => openSkill(skill.id)}
          className="focus-ring flex min-w-0 flex-1 flex-col gap-[3px] rounded text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base font-semibold text-fg">{name}</span>
            {skill.source === 'builtin' && (
              <span className="shrink-0 text-xs text-fg-muted">{skill.slug}</span>
            )}
            {chips.map((chip) => (
              <SourceChip key={chip.kind} chip={chip} />
            ))}
          </span>
          {skill.error ? (
            <span className="text-sm leading-4 text-danger">{errorText(skill.error)}</span>
          ) : (
            <>
              <span className="truncate text-sm leading-4 text-fg-secondary">{description}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5 text-xs text-fg-muted">
                {meta.map((item, index) => (
                  <MetaItem key={index} item={item} />
                ))}
              </span>
            </>
          )}
        </button>
        {skill.error ? (
          <Button size="sm" variant="outline" onClick={() => openSkill(skill.id)}>
            {t('skills.menu.open')}
          </Button>
        ) : (
          <Switch
            checked={skill.enabled}
            label={t('skills.enable', { name })}
            onChange={(enabled) => void toastOnError(update(workspaceId, skill.id, { enabled }))}
          />
        )}
        <MoreMenu label={t('skills.more', { name })} entries={entries} menuLabel={name} />
      </div>
      {confirming && (
        <div className="px-3.5 pb-2.5">
          <InlineConfirm
            message={t('skills.deleteConfirm', { name })}
            confirmLabel={t('skills.menu.delete')}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void toastOnError(remove(workspaceId, skill.id))}
          />
        </div>
      )}
    </li>
  )
}
