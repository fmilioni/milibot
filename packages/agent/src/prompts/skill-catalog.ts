import { clipLine } from '@milibot/shared'

export interface CatalogEntry {
  name: string
  description: string
}

/** Every bot pays for the catalog on every request, so a longer description is cut. */
export const CATALOG_DESCRIPTION_MAX = 250

/** The catalog of skills in the stable part of the system prompt: one line per skill. */
export function formatSkillCatalog(entries: readonly CatalogEntry[]): string {
  if (entries.length === 0) return ''
  const lines = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `- ${e.name} — ${clipLine(e.description, CATALOG_DESCRIPTION_MAX)}`)
  return [
    '# Skills',
    'Skills hold the instructions for specific kinds of work. Before a task of one of these kinds, load its skill with skill_load and follow it; no need to load it again while its instructions are still in this conversation.',
    ...lines,
  ].join('\n')
}
