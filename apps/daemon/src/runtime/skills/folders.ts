import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { parseSkillMd } from '@milibot/agent'
import { SKILL_LIMITS } from '@milibot/shared'

import { SKIPPED_NAMES } from './library'

export type NewSkillFile = { data: Buffer; executable: boolean }

/** Why a skill's files can't be saved (too many, too large, SKILL.md missing or invalid), or null. */
export function skillFilesProblem(files: Map<string, NewSkillFile>): string | null {
  if (files.size > SKILL_LIMITS.files) return `A skill can have at most ${SKILL_LIMITS.files} files.`
  let bytes = 0
  for (const file of files.values()) bytes += file.data.length
  if (bytes > SKILL_LIMITS.bytes) return `A skill can have at most ${SKILL_LIMITS.bytes / 1024 / 1024} MB.`
  const skillMd = files.get('SKILL.md')
  if (!skillMd) return 'SKILL.md is missing.'
  const parsed = parseSkillMd(skillMd.data.toString('utf8'))
  if (!parsed.ok) return parsed.error
  return null
}

/**
 * The skill folders of `<wsDir>/skills`: writes are staged in a dot folder next to them (invisible to the
 * library) and swapped in with renames, so a rescan never sees half a skill.
 */
export class SkillFolders {
  constructor(private readonly root: string) {}

  /** Creates the root and drops staging and trash folders a crash left behind. */
  prepare(): void {
    mkdirSync(this.root, { recursive: true })
    for (const name of readdirSync(this.root))
      if (name.startsWith('.staging-') || name.startsWith('.trash-'))
        rmSync(join(this.root, name), { recursive: true, force: true })
  }

  private staging(): string {
    mkdirSync(this.root, { recursive: true })
    return join(this.root, `.staging-${randomBytes(6).toString('hex')}`)
  }

  write(slug: string, files: Map<string, NewSkillFile>): void {
    const staging = this.staging()
    try {
      mkdirSync(staging)
      for (const [path, file] of files) {
        const target = join(staging, ...path.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.data, { mode: file.executable ? 0o755 : 0o644 })
      }
      const target = join(this.root, slug)
      const trash = existsSync(target) ? join(this.root, `.trash-${randomBytes(6).toString('hex')}`) : null
      if (trash) renameSync(target, trash)
      renameSync(staging, target)
      if (trash) rmSync(trash, { recursive: true, force: true })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Copies the folder `source` (skipped names and symlinks left out) as `slug`, with a new SKILL.md. */
  copy(source: string, slug: string, skillMd: string): void {
    const staging = this.staging()
    try {
      cpSync(source, staging, {
        recursive: true,
        filter: (path) => !SKIPPED_NAMES.has(basename(path)) && !lstatSync(path).isSymbolicLink(),
      })
      writeFileSync(join(staging, 'SKILL.md'), skillMd)
      renameSync(staging, join(this.root, slug))
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Replaces the SKILL.md of the folder `dir` in one rename. */
  writeSkillMd(dir: string, skillMd: string): void {
    const temp = join(dir, `.SKILL.md.${randomBytes(4).toString('hex')}`)
    writeFileSync(temp, skillMd)
    renameSync(temp, join(dir, 'SKILL.md'))
  }

  remove(slug: string): void {
    rmSync(join(this.root, slug), { recursive: true, force: true })
  }
}
