import type { Bot, Project } from '@milibot/shared'
import type { TFunction } from 'i18next'

import type { SelectOption } from './select'

/** Select value of "General" (no project) in project pickers and filters. */
export const GENERAL_PROJECT = 'general'

type BotSource = Record<string, Pick<Bot, 'id' | 'name'>> | Array<Pick<Bot, 'id' | 'name'>>

const botList = (bots: BotSource) => (Array.isArray(bots) ? bots : Object.values(bots))

/** The bots by name. */
export function botOptions(bots: BotSource): SelectOption<string>[] {
  return [...botList(bots)]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => ({ value: b.id, label: b.name }))
}

/**
 * "General" and the projects (archived ones left out unless `includeArchived`); `all` puts an "All
 * projects" option with an empty value first, for filters.
 */
export function projectOptions(
  projects: Array<Pick<Project, 'id' | 'name' | 'archivedAt'>>,
  t: TFunction,
  { all = false, includeArchived = false }: { all?: boolean; includeArchived?: boolean } = {},
): SelectOption<string>[] {
  return [
    ...(all ? [{ value: '', label: t('common.filters.allProjects') }] : []),
    { value: GENERAL_PROJECT, label: t('projects.general') },
    ...projects.filter((p) => includeArchived || !p.archivedAt).map((p) => ({ value: p.id, label: p.name })),
  ]
}

/** Names of the bots with these ids, joined; deleted bots are left out. */
export function botNames(ids: readonly string[], bots: Record<string, Pick<Bot, 'name'>>): string {
  return ids.flatMap((id) => (bots[id] ? [bots[id].name] : [])).join(', ')
}
