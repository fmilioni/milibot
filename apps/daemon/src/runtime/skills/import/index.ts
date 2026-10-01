import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'

import type {
  BotScope,
  LogFn,
  SkillImportCommitResult,
  SkillImportScan,
  SkillImportSource,
  SkillOrigin,
} from '@milibot/shared'

import { DaemonError } from '../../../errors'
import { GithubSkills } from './github'
import { type Install, installPrepared } from './install'
import {
  type Found,
  fromPaths,
  fromWorkspace,
  type ImportTarget,
  prepare,
  type Prepared,
  validation,
} from './scan'
import { SkillUpdates } from './updates'

export type { InstallInput } from './install'
export type { ImportTarget } from './scan'

const SCAN_TTL_MS = 30 * 60_000

interface ScanSession {
  id: string
  expiresAt: number
  origin: SkillImportScan['origin']
  candidates: Map<string, Prepared>
  download: string | null
  timer: NodeJS.Timeout
}

export interface SkillImporterDeps {
  /** `<wsDir>/skills/.imports`: downloaded archives of open scans. */
  importsDir: string
  workspaceDir: string
  targets(): ImportTarget[]
  install: Install
  saveOrigin(skillId: string, origin: SkillOrigin): void
  githubApi: string
  githubToken(): Promise<string | null>
  fetch: typeof fetch
  now(): number
  log?: LogFn
}

/**
 * Imports skills into the library: scans (local paths, GitHub zipballs, another workspace's skills folder)
 * produce candidates kept for 30 minutes; a commit copies the chosen ones. Imported GitHub skills are checked
 * for newer versions and can be imported again.
 */
export class SkillImporter {
  private readonly sessions = new Map<string, ScanSession>()
  private readonly github: GithubSkills
  private readonly updates: SkillUpdates

  constructor(private readonly deps: SkillImporterDeps) {
    this.github = new GithubSkills({
      api: deps.githubApi,
      token: deps.githubToken,
      fetch: deps.fetch,
      ...(deps.log ? { log: deps.log } : {}),
    })
    this.updates = new SkillUpdates({ ...deps, github: this.github })
  }

  start(): void {
    rmSync(this.deps.importsDir, { recursive: true, force: true })
  }

  stop(): void {
    for (const session of this.sessions.values()) clearTimeout(session.timer)
    this.sessions.clear()
  }

  scheduleChecks(targets: ImportTarget[]): void {
    this.updates.scheduleChecks(targets)
  }

  idle(): Promise<void> {
    return this.updates.idle()
  }

  updateFromSource(target: ImportTarget, apply: boolean): ReturnType<SkillUpdates['updateFromSource']> {
    return this.updates.updateFromSource(target, apply)
  }

  async scan(source: SkillImportSource): Promise<SkillImportScan> {
    const id = randomBytes(9).toString('hex')
    let download: string | null = null
    try {
      let found: Found[]
      let origin: SkillImportScan['origin']
      if (source.kind === 'github') {
        download = join(this.deps.importsDir, `${id}.zip`)
        const result = await this.github.skills(source.url, download)
        found = result.found
        origin = { kind: 'github', label: result.repo, ref: result.ref, sha: result.sha }
      } else if (source.kind === 'workspace') {
        found = fromWorkspace(this.deps.workspaceDir, source.workspaceId)
        origin = { kind: 'workspace', label: source.workspaceId, ref: null, sha: null }
      } else {
        found = await fromPaths(source.paths, this.deps.log)
        const first = source.paths[0] as string
        const label =
          source.paths.length > 1 ? `${basename(first)} +${source.paths.length - 1}` : basename(first)
        origin = { kind: 'paths', label, ref: null, sha: null }
      }
      if (found.length === 0) throw validation('No SKILL.md found there.', 'no_skills_found')
      const targets = this.deps.targets()
      const reserved = new Set<string>()
      const candidates = new Map<string, Prepared>()
      for (const item of found.sort((a, b) => a.key.localeCompare(b.key)))
        candidates.set(item.key, await prepare(item, targets, reserved))
      const expiresAt = this.deps.now() + SCAN_TTL_MS
      const timer = setTimeout(() => this.expire(id), SCAN_TTL_MS)
      timer.unref?.()
      this.sessions.set(id, { id, expiresAt, origin, candidates, download, timer })
      return { scanId: id, origin, candidates: [...candidates.values()].map((c) => c.candidate), expiresAt }
    } catch (err) {
      if (download) rmSync(download, { force: true })
      throw err
    }
  }

  private expire(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    clearTimeout(session.timer)
    this.sessions.delete(id)
    if (session.download) rmSync(session.download, { force: true })
  }

  async commit(input: {
    scanId: string
    paths: string[]
    allowedBots: BotScope
  }): Promise<SkillImportCommitResult> {
    const session = this.sessions.get(input.scanId)
    if (!session)
      throw new DaemonError('not_found', 'This search expired; search again.', { reason: 'scan_expired' })
    const result: SkillImportCommitResult = { imported: [], failed: [] }
    for (const path of new Set(input.paths)) {
      const prepared = session.candidates.get(path)
      if (!prepared) {
        result.failed.push({ path, error: 'Not part of this search.', code: 'not_in_scan', params: null })
        continue
      }
      if (prepared.candidate.error) {
        result.failed.push({
          path,
          error: prepared.candidate.error,
          code: prepared.candidate.errorCode ?? 'install_failed',
          params: prepared.candidate.errorParams,
        })
        continue
      }
      try {
        const { candidate, found } = prepared
        const origin: SkillOrigin = { ...found.origin, importedAt: this.deps.now() }
        if (origin.kind === 'github' && origin.repo && origin.sha)
          origin.pathSha =
            (await this.github.pathCommit(origin.repo, origin.sha, origin.path ?? '').catch(() => null))
              ?.sha ?? null
        const skill = await installPrepared(
          prepared,
          {
            slug: candidate.importAs,
            origin,
            allowedBots: input.allowedBots,
            replaceId: candidate.conflict === 'update' ? candidate.existingSkillId : null,
          },
          this.deps.install,
        )
        result.imported.push(skill)
      } catch (err) {
        const detail = (err as Error).message
        result.failed.push({ path, error: detail, code: 'install_failed', params: { detail } })
      }
    }
    return result
  }
}
