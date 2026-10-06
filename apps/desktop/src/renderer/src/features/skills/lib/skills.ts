import {
  type Bot,
  foldText,
  parseGithubSkillUrl,
  type Skill,
  type SkillFile,
  type SkillImportCandidate,
  type SkillOrigin,
  type Workspace,
} from '@milibot/shared'
import type { TFunction } from 'i18next'

import { formatRelative } from '@/lib/format'
import { type PlatformKind, platformKind, shortPath as homePath } from '@/lib/platform'
import { botNames } from '@/lib/select-options'

export type SkillGroup = 'yours' | 'taught' | 'builtin'
export type SkillFilter = 'all' | SkillGroup

/** Order of the groups on the Skills screen. */
const SKILL_GROUPS: SkillGroup[] = ['yours', 'taught', 'builtin']

/** Built-ins shown before "Show more" (the rest follow in this order too). */
const BUILTIN_ORDER = [
  'web-browsing',
  'using-the-screen',
  'code-and-repos',
  'team-management',
  'design',
  'slides',
  'documents-pdf',
  'design-to-code',
  'projects',
  'plans-and-sessions',
  'boards',
  'knowledge-base',
  'routines',
  'secrets-and-variables',
  'skill-creator',
]
export const BUILTINS_SHOWN = 6

function skillGroup(skill: Pick<Skill, 'source'>): SkillGroup {
  return skill.source === 'builtin' ? 'builtin' : skill.source === 'taught' ? 'taught' : 'yours'
}

export function countByFilter(skills: Skill[]): Record<SkillFilter, number> {
  const counts: Record<SkillFilter, number> = { all: skills.length, yours: 0, taught: 0, builtin: 0 }
  for (const skill of skills) counts[skillGroup(skill)]++
  return counts
}

/** Skills of `filter` matching `query` (slug, name, description or the displayed name/description). */
export function filterSkills(
  skills: Skill[],
  filter: SkillFilter,
  query: string,
  display: (skill: Skill) => { name: string; description: string } = (s) => s,
): Skill[] {
  const words = foldText(query, { trim: true }).split(/\s+/).filter(Boolean)
  return skills.filter((skill) => {
    if (filter !== 'all' && skillGroup(skill) !== filter) return false
    if (!words.length) return true
    const shown = display(skill)
    const haystack = foldText(
      [skill.slug, skill.name, skill.description, shown.name, shown.description].join(' '),
      { trim: true },
    )
    return words.every((w) => haystack.includes(w))
  })
}

function builtinRank(slug: string): number {
  const index = BUILTIN_ORDER.indexOf(slug)
  return index < 0 ? BUILTIN_ORDER.length : index
}

/** Skills by group in screen order: yours (valid first, by name), taught (by name), built-ins (fixed order). */
export function groupSkills(skills: Skill[]): Array<{ group: SkillGroup; skills: Skill[] }> {
  return SKILL_GROUPS.map((group) => {
    const members = skills.filter((s) => skillGroup(s) === group)
    members.sort((a, b) => {
      if (group === 'builtin')
        return builtinRank(a.slug) - builtinRank(b.slug) || a.slug.localeCompare(b.slug)
      if (!!a.error !== !!b.error) return a.error ? 1 : -1
      return a.name.localeCompare(b.name)
    })
    return { group, skills: members }
  }).filter((g) => g.skills.length > 0)
}

export function skillOrigin(skill: Pick<Skill, 'origin'>): SkillOrigin | null {
  const origin = skill.origin as Partial<SkillOrigin> | null
  if (!origin || typeof origin.kind !== 'string') return null
  return origin as SkillOrigin
}

export type SkillChip =
  | { kind: 'github'; label: string }
  | { kind: 'folder' }
  | { kind: 'zip' }
  | { kind: 'workspace' }
  | { kind: 'bot'; name: string }
  | { kind: 'update' }

/** Where the skill came from and whether a newer version exists (chips next to its name). */
export function sourceChips(skill: Skill, bots: Record<string, Bot>): SkillChip[] {
  const chips: SkillChip[] = []
  const origin = skillOrigin(skill)
  if (skill.source === 'import' && origin) {
    if (origin.kind === 'github') chips.push({ kind: 'github', label: origin.repo ?? 'GitHub' })
    else if (origin.kind === 'zip') chips.push({ kind: 'zip' })
    else if (origin.kind === 'workspace') chips.push({ kind: 'workspace' })
    else chips.push({ kind: 'folder' })
  } else if (skill.source === 'user') {
    chips.push({ kind: 'folder' })
  } else if (skill.source === 'bot' && skill.authorBotId) {
    chips.push({ kind: 'bot', name: bots[skill.authorBotId]?.name ?? '…' })
  }
  if (skill.updateAvailable) chips.push({ kind: 'update' })
  return chips
}

export type SkillAccess = { kind: 'all' } | { kind: 'only'; name: string } | { kind: 'some'; names: string[] }

/** Who may use it: every bot, one bot, or a list (deleted bots left out). */
export function skillAccess(skill: Pick<Skill, 'allowedBots'>, bots: Record<string, Bot>): SkillAccess {
  if (skill.allowedBots === 'all') return { kind: 'all' }
  const names = skill.allowedBots.flatMap((id) => (bots[id] ? [bots[id].name] : []))
  return names.length === 1 ? { kind: 'only', name: names[0] as string } : { kind: 'some', names }
}

/** One item of the line under a skill's description: a tag with an icon, or plain text. */
export type SkillMetaItem =
  { kind: 'tag'; icon: 'tools' | 'scripts' | 'user' | 'users'; text: string } | { kind: 'text'; text: string }

/**
 * Meta line of a skill row: built-ins show tools/scripts, the tokens they cost and, for skills on only for
 * the first bot, who has them on; the others show scripts, access and files.
 */
export function skillRowMeta(
  skill: Skill,
  bots: Record<string, Bot>,
  { first, t, locale, now }: { first: boolean; t: TFunction; locale: string; now?: number },
): SkillMetaItem[] {
  const items: SkillMetaItem[] = []
  const scripts: SkillMetaItem = { kind: 'tag', icon: 'scripts', text: t('skills.meta.scripts') }
  if (skill.source === 'builtin') {
    if (skill.toolCount > 0)
      items.push({ kind: 'tag', icon: 'tools', text: t('skills.meta.tools', { count: skill.toolCount }) })
    else if (skill.hasScripts) items.push(scripts)
    items.push({
      kind: 'text',
      text: t(first ? 'skills.meta.tokensOnLoad' : 'skills.meta.tokens', {
        tokens: new Intl.NumberFormat(locale).format(skill.tokens),
      }),
    })
    if (skill.defaultFor === 'first') {
      const names = botNames(skill.enabledFor, bots)
      items.push({ kind: 'text', text: '·' })
      items.push({
        kind: 'tag',
        icon: 'user',
        text: names ? t('skills.access.activeFor', { names }) : t('skills.access.activeForNone'),
      })
    }
    return items
  }
  const access = skillAccess(skill, bots)
  if (skill.hasScripts) items.push(scripts)
  if (access.kind === 'only')
    items.push({ kind: 'tag', icon: 'user', text: t('skills.access.only', { name: access.name }) })
  else if (skill.source === 'taught' && access.kind === 'all')
    items.push({ kind: 'tag', icon: 'users', text: t('skills.access.allChip') })
  const parts =
    skill.source === 'taught'
      ? skill.fileCount > 0
        ? [t('skills.meta.captures', { count: skill.fileCount })]
        : []
      : [t('skills.meta.files', { count: skill.fileCount })]
  if (skill.source !== 'taught') {
    if (access.kind === 'all') parts.push(t('skills.access.all'))
    else if (access.kind === 'some') parts.push(access.names.join(', ') || t('skills.access.none'))
  }
  if (skill.source === 'bot') parts.push(formatRelative(skill.updatedAt, locale, now))
  if (parts.length) items.push({ kind: 'text', text: parts.join(' · ') })
  return items
}

/** Lines of the "Origin" card of a skill; `mono` for a path or a commit. */
export function originLines(
  skill: Pick<Skill, 'source' | 'origin' | 'authorBotId' | 'createdAt'>,
  {
    bots,
    workspaces,
    t,
    locale,
    platform,
  }: {
    bots: Record<string, Pick<Bot, 'name'>>
    workspaces: Array<Pick<Workspace, 'id' | 'name'>>
    t: TFunction
    locale: string
    platform?: PlatformKind
  },
): Array<{ text: string; mono?: boolean }> {
  const date = (ts: number | null | undefined) =>
    ts ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(ts) : '…'
  const origin = skillOrigin(skill)
  if (skill.source === 'builtin') return [{ text: t('skills.detail.origin.builtin') }]
  if (skill.source === 'taught') return [{ text: t('skills.detail.origin.taught') }]
  if (skill.source === 'bot')
    return [
      {
        text: t('skills.detail.origin.bot', {
          name: skill.authorBotId ? (bots[skill.authorBotId]?.name ?? '…') : '…',
          date: date(skill.createdAt),
        }),
      },
    ]
  if (skill.source === 'user' || !origin)
    return [{ text: t('skills.detail.origin.user', { date: date(skill.createdAt) }) }]
  const imported = {
    text:
      t('skills.detail.origin.importedAt', { date: date(origin.importedAt) }) +
      (origin.latestSha ? ` · ${t('skills.detail.origin.newVersion', { date: date(origin.latestAt) })}` : ''),
  }
  if (origin.kind === 'github')
    return [
      { text: `github.com/${origin.repo ?? ''}` },
      {
        text: [origin.ref, origin.path || null, origin.sha?.slice(0, 7)].filter(Boolean).join(' · '),
        mono: true,
      },
      imported,
    ]
  if (origin.kind === 'workspace')
    return [
      {
        text: t('skills.detail.origin.workspace', {
          name: workspaces.find((w) => w.id === origin.workspaceId)?.name ?? origin.workspaceId ?? '…',
        }),
      },
      imported,
    ]
  return [
    {
      text: shortPath(
        `${origin.localPath ?? origin.vmPath ?? ''}${origin.kind === 'zip' ? `#${origin.path || '.'}` : ''}`,
        platform,
      ),
      mono: true,
    },
    imported,
  ]
}

/** `~/Downloads/x` for a path in the home folder; a zip candidate `a.zip#dir` → `a.zip › dir`. */
export function shortPath(path: string, kind: PlatformKind = platformKind()): string {
  const home = homePath(path, kind)
  const hash = home.lastIndexOf('#')
  if (hash < 0) return home
  const dir = home.slice(hash + 1)
  return dir === '.' ? home.slice(0, hash) : `${home.slice(0, hash)} › ${dir}`
}

/** Candidates checked by default: importable, and not clashing with a skill included in Milibot. */
export function defaultSelection(candidates: SkillImportCandidate[]): string[] {
  return candidates.filter((c) => !c.error && c.conflict !== 'similar_builtin').map((c) => c.path)
}

/** The text is a GitHub repository address the importer understands. */
export function isGithubAddress(text: string): boolean {
  return parseGithubSkillUrl(text) !== null
}

/** Files and folders dropped or picked: only what can hold skills (folders, `.md`, `.zip`, `.skill`). */
export function importablePaths(paths: string[]): string[] {
  return paths.filter((p) => p && (!/\.[^/]+$/.test(p) || /\.(md|zip|skill)$/i.test(p)))
}

export interface FrontmatterView {
  fields: Array<{ key: string; value: string }>
  body: string
}

/** Top-level `key: value` fields of a SKILL.md frontmatter (folded values joined) and the body after it. */
export function splitFrontmatter(skillMd: string): FrontmatterView {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(skillMd)
  if (!match) return { fields: [], body: skillMd }
  const fields: FrontmatterView['fields'] = []
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) {
      fields.push({ key: field[1] as string, value: unquote((field[2] as string).trim()) })
      continue
    }
    const last = fields.at(-1)
    if (last && /^\s+\S/.test(line)) {
      const part = line.trim()
      last.value = ['>', '|', '>-', '|-'].includes(last.value) ? part : `${last.value} ${part}`.trim()
    }
  }
  return { fields, body: skillMd.slice(match[0].length).replace(/^\s*\n/, '') }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value) as string
      } catch {
        return value.slice(1, -1)
      }
    }
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

export interface FileTreeRow {
  name: string
  path: string
  depth: number
  folder: boolean
}

/** Root files (SKILL.md first), then each folder as a row followed by its contents, alphabetically. */
export function fileTree(files: SkillFile[]): FileTreeRow[] {
  interface Node {
    files: string[]
    folders: Map<string, Node>
  }
  const root: Node = { files: [], folders: new Map() }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part)
      if (!next) {
        next = { files: [], folders: new Map() }
        node.folders.set(part, next)
      }
      node = next
    }
    node.files.push(parts.at(-1) as string)
  }
  const rows: FileTreeRow[] = []
  const visit = (node: Node, prefix: string, depth: number) => {
    const names = [...node.files].sort((a, b) =>
      depth === 0 && a === 'SKILL.md' ? -1 : depth === 0 && b === 'SKILL.md' ? 1 : a.localeCompare(b),
    )
    for (const name of names) rows.push({ name, path: `${prefix}${name}`, depth, folder: false })
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({ name: `${name}/`, path: `${prefix}${name}`, depth, folder: true })
      visit(child, `${prefix}${name}/`, depth + 1)
    }
  }
  visit(root, '', 0)
  return rows
}

/** i18n key of an import/update error from the daemon (`details.reason`), or null to show its message. */
export function importErrorKey(details: unknown): string | null {
  const { reason, hasToken } = (details ?? {}) as { reason?: string; hasToken?: boolean }
  switch (reason) {
    case 'github_not_found':
      return hasToken ? 'skills.import.errors.notFound' : 'skills.import.errors.notFoundNoToken'
    case 'github_ref_not_found':
    case 'github_unauthorized':
    case 'github_rate_limited':
    case 'github_unreachable':
    case 'github_failed':
    case 'invalid_url':
    case 'no_skills_found':
    case 'too_large':
    case 'too_many_files':
    case 'path_not_found':
    case 'unsupported_file':
    case 'not_a_zip':
    case 'scan_expired':
    case 'workspace_not_found':
    case 'source_missing':
      return `skills.import.errors.${reason}`
    default:
      return null
  }
}

/** The GitHub error that settings can fix (a token in "GitHub and credentials"). */
export function needsGithubToken(details: unknown): boolean {
  const { reason, hasToken } = (details ?? {}) as { reason?: string; hasToken?: boolean }
  return (reason === 'github_not_found' && !hasToken) || reason === 'github_unauthorized'
}

/** i18n key for the common SKILL.md problems (the daemon's text is shown otherwise). */
export function skillErrorKey(error: string): string | null {
  if (/description is required/.test(error)) return 'skills.errors.noDescription'
  if (/must start with a frontmatter/.test(error)) return 'skills.errors.noFrontmatter'
  if (/SKILL\.md is missing/.test(error)) return 'skills.errors.missing'
  if (/must match the folder name/.test(error)) return 'skills.errors.nameMismatch'
  if (/included in Milibot already has this name/.test(error)) return 'skills.errors.builtinName'
  if (/^Folder name:/.test(error)) return 'skills.errors.folderName'
  return null
}
