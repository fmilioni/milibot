import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { type GithubPin, GithubSkills } from './github'
import { type Install, installPrepared } from './install'
import {
  type Found,
  fromPaths,
  fromWorkspace,
  type ImportTarget,
  prepare,
  type Prepared,
  validation,
  zipSkills,
} from './scan'
import { SkillUpdates } from './updates'

export type { InstallInput } from './install'
export type { ImportTarget } from './scan'

const SCAN_TTL_MS = 30 * 60_000

/**
 * What a bot's scan read, so that a later scan gets the very same bytes: a GitHub commit, or a zip in the VM
 * by its hash.
 */
export type ScanPin = ({ kind: 'github' } & GithubPin) | { kind: 'vm_zip'; vmPath: string; sha256: string }

/** A source a bot imports from: a GitHub address, or a zip it read from the VM. */
export type BotImportSource =
  { kind: 'github'; url: string } | { kind: 'vm_zip'; vmPath: string; data: Buffer }

interface ScanSession {
  id: string
  expiresAt: number
  origin: SkillImportScan['origin']
  candidates: Map<string, Prepared>
  download: string | null
  timer: NodeJS.Timeout
  pin: ScanPin | null
}

interface Loaded {
  found: Found[]
  origin: SkillImportScan['origin']
  pin: ScanPin | null
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

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
    return (
      await this.open(async (download) => {
        if (source.kind === 'github') {
          const result = await this.github.skills(source.url, download())
          return { found: result.found, origin: this.githubOrigin(result.pin), pin: null }
        }
        if (source.kind === 'workspace') {
          const found = fromWorkspace(this.deps.workspaceDir, source.workspaceId)
          return {
            found,
            origin: { kind: 'workspace', label: source.workspaceId, ref: null, sha: null },
            pin: null,
          }
        }
        const found = await fromPaths(source.paths, this.deps.log)
        const first = source.paths[0] as string
        const label =
          source.paths.length > 1 ? `${basename(first)} +${source.paths.length - 1}` : basename(first)
        return { found, origin: { kind: 'paths', label, ref: null, sha: null }, pin: null }
      })
    ).scan
  }

  /** A bot's scan: the result says what was read (`pin`), for `scanPinned` to read it again. */
  async scanForBot(source: BotImportSource): Promise<{ scan: SkillImportScan; pin: ScanPin }> {
    const { scan, pin } = await this.open(async (download) => {
      if (source.kind === 'github') {
        const result = await this.github.skills(source.url, download())
        return {
          found: result.found,
          origin: this.githubOrigin(result.pin),
          pin: { kind: 'github', ...result.pin },
        }
      }
      return this.vmZip(source.vmPath, source.data, download())
    })
    return { scan, pin: pin as ScanPin }
  }

  /**
   * The same source read again (a scan expired, or the runtime restarted): a GitHub commit, or the zip's
   * current bytes, which must still hash the same (else `null`).
   */
  async scanPinned(pin: ScanPin, zip?: Buffer): Promise<SkillImportScan | null> {
    if (pin.kind === 'vm_zip' && (!zip || sha256(zip) !== pin.sha256)) return null
    const { scan } = await this.open(async (download) => {
      if (pin.kind === 'github') {
        const { kind: _kind, ...at } = pin
        const result = await this.github.skillsAt(at, download())
        return { found: result.found, origin: this.githubOrigin(at), pin }
      }
      return this.vmZip(pin.vmPath, zip as Buffer, download())
    })
    return scan
  }

  /**
   * A hash of what each valid candidate would install: its files (path, mode, content) and the name it
   * takes. An approval installs only what still hashes the same as what the user was shown.
   */
  async digests(scanId: string): Promise<Record<string, string>> {
    const session = this.session(scanId)
    const out: Record<string, string> = {}
    for (const [key, prepared] of session.candidates) {
      if (prepared.candidate.error) continue
      const files: string[] = []
      for (const file of [...prepared.found.files].sort((a, b) => a.path.localeCompare(b.path)))
        files.push(`${file.path}\0${file.executable ? 1 : 0}\0${sha256(await file.read())}`)
      const { importAs, conflict } = prepared.candidate
      out[key] = sha256(JSON.stringify({ importAs, conflict, files }))
    }
    return out
  }

  /** SKILL.md of each candidate as it would be written (null when invalid). */
  skillMds(scanId: string): Record<string, string | null> {
    return Object.fromEntries(
      [...this.session(scanId).candidates].map(([key, prepared]) => [key, prepared.skillMd]),
    )
  }

  private githubOrigin(pin: GithubPin): SkillImportScan['origin'] {
    return { kind: 'github', label: pin.repo, ref: pin.ref, sha: pin.sha }
  }

  private async vmZip(vmPath: string, data: Buffer, file: string): Promise<Loaded> {
    mkdirSync(this.deps.importsDir, { recursive: true })
    writeFileSync(file, data, { mode: 0o600 })
    const found = await zipSkills(file, { kind: 'zip', vmPath }, this.deps.log)
    return {
      found,
      origin: { kind: 'paths', label: basename(vmPath), ref: null, sha: null },
      pin: { kind: 'vm_zip', vmPath, sha256: sha256(data) },
    }
  }

  /** Runs a scan: `load` finds the skills (`download()` names the file a download goes to). */
  private async open(
    load: (download: () => string) => Promise<Loaded>,
  ): Promise<{ scan: SkillImportScan; pin: ScanPin | null }> {
    const id = randomBytes(9).toString('hex')
    let download: string | null = null
    try {
      const { found, origin, pin } = await load(() => {
        download = join(this.deps.importsDir, `${id}.zip`)
        return download
      })
      if (found.length === 0) throw validation('No SKILL.md found there.', 'no_skills_found')
      const targets = this.deps.targets()
      const reserved = new Set<string>()
      const candidates = new Map<string, Prepared>()
      for (const item of found.sort((a, b) => a.key.localeCompare(b.key)))
        candidates.set(item.key, await prepare(item, targets, reserved))
      const expiresAt = this.deps.now() + SCAN_TTL_MS
      const timer = setTimeout(() => this.expire(id), SCAN_TTL_MS)
      timer.unref?.()
      this.sessions.set(id, { id, expiresAt, origin, candidates, download, timer, pin })
      return {
        scan: { scanId: id, origin, candidates: [...candidates.values()].map((c) => c.candidate), expiresAt },
        pin,
      }
    } catch (err) {
      if (download) rmSync(download, { force: true })
      throw err
    }
  }

  private session(scanId: string): ScanSession {
    const session = this.sessions.get(scanId)
    if (!session)
      throw new DaemonError('not_found', 'This search expired; search again.', { reason: 'scan_expired' })
    return session
  }

  /** Whether a scan is still open. */
  isOpen(scanId: string): boolean {
    return this.sessions.has(scanId)
  }

  /** Forgets a scan (its download removed). */
  discard(scanId: string): void {
    this.expire(scanId)
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
    const session = this.session(input.scanId)
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
