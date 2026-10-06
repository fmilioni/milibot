import { createWriteStream, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import { type LogFn, parseGithubSkillUrl } from '@milibot/shared'

import { DaemonError } from '../../../errors'
import { ZipReader } from '../../../util/zip'
import { discoverSkillDirs, type Found, under, validation, zipFiles } from './scan'

/** Largest GitHub archive downloaded for a scan. */
const GITHUB_ZIP_MAX_BYTES = 50 * 1024 * 1024

/** A scanned commit: what a later scan reads again to get the very same files. */
export interface GithubPin {
  repo: string
  ref: string
  sha: string
  scope: string | null
}

export interface GithubScan {
  found: Found[]
  pin: GithubPin
}

export interface GithubSkillsDeps {
  /** REST API base (tests point it at a local server). */
  api: string
  token(): Promise<string | null>
  fetch: typeof fetch
  log?: LogFn
}

/** Skills in GitHub repositories: refs resolved to a commit, the zipball of that commit searched. */
export class GithubSkills {
  constructor(private readonly deps: GithubSkillsDeps) {}

  private async request(
    path: string,
    token: string | null,
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    try {
      return await this.deps.fetch(`${this.deps.api}${path}`, {
        headers: {
          accept,
          'user-agent': 'Milibot',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      throw new DaemonError('conflict', `GitHub could not be reached: ${(err as Error).message}`, {
        reason: 'github_unreachable',
      })
    }
  }

  private failure(res: Response, token: string | null, what: 'repo' | 'ref' | 'other'): DaemonError {
    if (res.status === 401) return validation('GitHub refused the token.', 'github_unauthorized')
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0')
      return new DaemonError('conflict', 'GitHub request limit reached; try again later.', {
        reason: 'github_rate_limited',
      })
    if (what === 'ref' && (res.status === 404 || res.status === 422))
      return new DaemonError('not_found', 'Branch, tag or commit not found.', {
        reason: 'github_ref_not_found',
      })
    if (res.status === 404)
      return new DaemonError('not_found', 'Repository not found.', {
        reason: 'github_not_found',
        hasToken: token !== null,
      })
    return new DaemonError('conflict', `GitHub answered ${res.status}.`, {
      reason: 'github_failed',
      status: res.status,
    })
  }

  private async commitSha(repo: string, ref: string, token: string | null): Promise<string> {
    const res = await this.request(
      `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      token,
      'application/vnd.github.sha',
    )
    if (!res.ok) throw this.failure(res, token, 'ref')
    const sha = (await res.text()).trim()
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw this.failure(res, token, 'ref')
    return sha
  }

  /** Newest commit at `ref` that changed `path` (the whole repo when empty). */
  async pathCommit(
    repo: string,
    ref: string,
    path: string,
  ): Promise<{ sha: string; at: number | null } | null> {
    const token = await this.deps.token()
    const query = new URLSearchParams({ sha: ref, per_page: '1' })
    if (path) query.set('path', path)
    const res = await this.request(`/repos/${repo}/commits?${query}`, token)
    if (!res.ok) throw this.failure(res, token, 'ref')
    const list = (await res.json()) as Array<{ sha?: string; commit?: { committer?: { date?: string } } }>
    const first = list[0]
    if (!first?.sha) return null
    const date = first.commit?.committer?.date
    return { sha: first.sha, at: date ? Date.parse(date) : null }
  }

  private async download(repo: string, sha: string, token: string | null, target: string): Promise<void> {
    const res = await this.request(`/repos/${repo}/zipball/${sha}`, token)
    if (!res.ok || !res.body) throw this.failure(res, token, 'other')
    const tooLarge = () =>
      validation(
        `The repository archive is larger than ${GITHUB_ZIP_MAX_BYTES / 1024 / 1024} MB.`,
        'too_large',
      )
    if (Number(res.headers.get('content-length') ?? 0) > GITHUB_ZIP_MAX_BYTES) throw tooLarge()
    mkdirSync(dirname(target), { recursive: true })
    let bytes = 0
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          callback(bytes > GITHUB_ZIP_MAX_BYTES ? tooLarge() : null, chunk)
        },
      }),
      createWriteStream(target, { mode: 0o600 }),
    )
  }

  /**
   * The skills at a repository address (`owner/repo[/tree/<ref>[/<path>]]`), downloaded to `target`. A ref
   * with slashes is found by moving path segments into it while GitHub answers "ref not found".
   */
  async skills(url: string, target: string): Promise<GithubScan> {
    const location = parseGithubSkillUrl(url)
    if (!location) throw validation('Not a GitHub repository address.', 'invalid_url')
    const token = await this.deps.token()
    const res = await this.request(`/repos/${location.owner}/${location.repo}`, token)
    if (!res.ok) throw this.failure(res, token, 'repo')
    const info = (await res.json()) as { full_name?: string; default_branch?: string }
    const repo = info.full_name ?? `${location.owner}/${location.repo}`
    let ref = location.ref ?? info.default_branch ?? 'main'
    let path = location.path
    let sha: string
    for (;;) {
      try {
        sha = await this.commitSha(repo, ref, token)
        break
      } catch (err) {
        const reason = (err as DaemonError).details as { reason?: string } | undefined
        if (reason?.reason !== 'github_ref_not_found' || !path) throw err
        const [first, ...rest] = path.split('/')
        ref = `${ref}/${first}`
        path = rest.length ? rest.join('/') : null
      }
    }
    return this.skillsAt({ repo, ref, sha, scope: path }, target, { token, rootName: location.repo })
  }

  /** The skills of a commit already resolved (`scope`: the folder searched, null = the whole repo). */
  async skillsAt(
    pin: GithubPin,
    target: string,
    known: { token: string | null; rootName: string } | null = null,
  ): Promise<GithubScan> {
    const { repo, ref, sha, scope } = pin
    const auth = known ? known.token : await this.deps.token()
    await this.download(repo, sha, auth, target)
    let reader: ZipReader
    try {
      reader = await ZipReader.open(target)
    } catch {
      throw new DaemonError('conflict', 'GitHub sent an unreadable archive.', { reason: 'github_failed' })
    }
    const { files, rejected } = zipFiles(reader, true)
    if (rejected.length) this.deps.log?.('warn', 'skill import: unsafe zip entries skipped', { rejected })
    const name = known?.rootName ?? (repo.split('/').at(-1) as string)
    const found = discoverSkillDirs(
      files.map((f) => f.path),
      scope,
    ).map((dir): Found => ({
      key: dir || '.',
      folderName: dir ? basename(dir) : name,
      files: under(files, dir),
      origin: { kind: 'github', repo, ref, sha, path: dir },
    }))
    return { found, pin }
  }
}
