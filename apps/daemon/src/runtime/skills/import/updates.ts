import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { LogFn, SkillOrigin } from '@milibot/shared'

import { DaemonError } from '../../../errors'
import type { GithubSkills } from './github'
import { type Install, installPrepared } from './install'
import { type Found, fromPaths, fromWorkspace, type ImportTarget, prepare, validation } from './scan'

/** How often an imported GitHub skill is checked for a newer version (on list, in the background). */
const UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000

export interface SkillUpdatesDeps {
  importsDir: string
  workspaceDir: string
  github: GithubSkills
  targets(): ImportTarget[]
  install: Install
  saveOrigin(skillId: string, origin: SkillOrigin): void
  now(): number
  log?: LogFn
}

/** Imported skills against their source: background checks for newer GitHub commits, and re-imports. */
export class SkillUpdates {
  private readonly checking = new Set<string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: SkillUpdatesDeps) {}

  /** Checks imported GitHub skills not checked in the last 6 hours, one at a time, in the background. */
  scheduleChecks(targets: ImportTarget[]): void {
    const now = this.deps.now()
    for (const target of targets) {
      const origin = target.origin
      if (target.source !== 'import' || origin?.kind !== 'github' || !origin.repo) continue
      if ((origin.checkedAt ?? origin.importedAt ?? 0) > now - UPDATE_CHECK_INTERVAL_MS) continue
      if (this.checking.has(target.id)) continue
      this.checking.add(target.id)
      this.queue = this.queue
        .then(async () => {
          await this.check(target)
        })
        .catch((err: Error) => {
          this.deps.log?.('warn', 'skill update check failed', { skillId: target.id, err: err.message })
          this.deps.saveOrigin(target.id, { ...origin, checkedAt: this.deps.now() })
        })
        .finally(() => this.checking.delete(target.id))
    }
  }

  /** Resolves when no update check is running (tests). */
  idle(): Promise<void> {
    return this.queue
  }

  private async check(target: ImportTarget): Promise<{ available: boolean; latest: string | null }> {
    const origin = target.origin as SkillOrigin
    const repo = origin.repo as string
    const path = origin.path ?? ''
    const { github } = this.deps
    const baseline =
      origin.pathSha ?? (origin.sha ? ((await github.pathCommit(repo, origin.sha, path))?.sha ?? null) : null)
    const latest = await github.pathCommit(repo, origin.ref ?? origin.sha ?? 'HEAD', path)
    const available = !!latest && !!baseline && latest.sha !== baseline
    this.deps.saveOrigin(target.id, {
      ...origin,
      pathSha: baseline,
      latestSha: available ? (latest?.sha ?? null) : null,
      latestAt: available ? (latest?.at ?? null) : null,
      checkedAt: this.deps.now(),
    })
    return { available, latest: latest?.sha ?? null }
  }

  /**
   * Looks where the skill came from: on GitHub, whether a newer commit changed its folder; with `apply`,
   * reads it again (GitHub, the local folder or zip, the other workspace) and replaces the files.
   */
  async updateFromSource(
    target: ImportTarget,
    apply: boolean,
  ): Promise<{ updateAvailable: boolean; sha: string | null; latestSha: string | null; updated: boolean }> {
    const origin = target.origin
    if (target.source !== 'import' || !origin)
      throw new DaemonError('conflict', 'This skill was not imported', { reason: 'not_imported' })
    let available = false
    let latest: string | null = null
    if (origin.kind === 'github') {
      const checked = await this.check(target)
      available = checked.available
      latest = checked.latest
    }
    if (!apply)
      return { updateAvailable: available, sha: origin.sha ?? null, latestSha: latest, updated: false }

    const download = join(this.deps.importsDir, `${randomBytes(9).toString('hex')}.zip`)
    try {
      let found: Found[]
      if (origin.kind === 'github') {
        const dir = origin.path ?? ''
        found = (
          await this.deps.github.skills(
            `${origin.repo}/tree/${origin.ref ?? 'HEAD'}${dir ? `/${dir}` : ''}`,
            download,
          )
        ).found
      } else if (origin.kind === 'workspace') {
        found = fromWorkspace(this.deps.workspaceDir, origin.workspaceId ?? '')
      } else {
        if (!origin.localPath || !existsSync(origin.localPath))
          throw new DaemonError('not_found', 'The original files are no longer there.', {
            reason: 'source_missing',
          })
        found = await fromPaths([origin.localPath], this.deps.log)
      }
      const match = found.find((f) => (f.origin.path ?? '') === (origin.path ?? ''))
      if (!match)
        throw new DaemonError('not_found', 'The skill is no longer where it was imported from.', {
          reason: 'source_missing',
        })
      const others = this.deps.targets().filter((t) => t.id !== target.id)
      const prepared = await prepare(match, others, new Set())
      if (prepared.candidate.error) throw validation(prepared.candidate.error, 'invalid_skill_md')
      const nextOrigin: SkillOrigin = {
        ...match.origin,
        importedAt: this.deps.now(),
        pathSha: origin.kind === 'github' ? latest : null,
        latestSha: null,
        latestAt: null,
        checkedAt: this.deps.now(),
      }
      await installPrepared(
        prepared,
        { slug: target.slug, origin: nextOrigin, allowedBots: null, replaceId: target.id },
        this.deps.install,
      )
      return { updateAvailable: false, sha: nextOrigin.sha ?? null, latestSha: latest, updated: true }
    } finally {
      rmSync(download, { force: true })
    }
  }
}
