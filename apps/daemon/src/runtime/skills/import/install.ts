import { withSkillName } from '@milibot/agent'
import type { BotScope, Skill, SkillOrigin } from '@milibot/shared'

import type { Prepared } from './scan'

export interface InstallInput {
  slug: string
  files: Map<string, { data: Buffer; executable: boolean }>
  origin: SkillOrigin
  allowedBots: BotScope | null
  /** Folder skill replaced in place (same id, switches kept). */
  replaceId: string | null
}

export type Install = (input: InstallInput) => Skill

/**
 * Reads a prepared candidate's files and hands them to the library: SKILL.md renamed when it is imported
 * under another name, files starting with `#!` executable.
 */
export async function installPrepared(
  prepared: Prepared,
  input: Omit<InstallInput, 'files'>,
  install: Install,
): Promise<Skill> {
  const files: InstallInput['files'] = new Map()
  for (const file of prepared.found.files) {
    if (file.path === 'SKILL.md') continue
    const data = await file.read()
    files.set(file.path, { data, executable: file.executable || (data[0] === 0x23 && data[1] === 0x21) })
  }
  let skillMd = prepared.skillMd as string
  if (input.slug !== prepared.candidate.name) skillMd = withSkillName(skillMd, input.slug) ?? skillMd
  files.set('SKILL.md', { data: Buffer.from(skillMd, 'utf8'), executable: false })
  return install({ ...input, files })
}
