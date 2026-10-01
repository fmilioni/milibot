export interface GithubSkillLocation {
  owner: string
  repo: string
  /** Branch, tag or commit (null: the default branch). */
  ref: string | null
  /** Folder to look in (null: the whole repo). */
  path: string | null
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/

/**
 * `owner/repo`, a repo URL (https, `github.com/…`, `git@github.com:…`), `/tree/<ref>/<dir>` or
 * `/blob/<ref>/<dir>/SKILL.md` (the file's folder). A ref with slashes is read as its first segment.
 */
export function parseGithubSkillUrl(input: string): GithubSkillLocation | null {
  let text = input.trim()
  if (!text) return null
  text = text.replace(/^git@github\.com:/i, 'github.com/')
  text = text.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
  if (/^[a-z]+:\/\//i.test(text)) return null
  text = text.split(/[?#]/)[0] as string
  const parts = text.split('/').filter(Boolean)
  const [owner, rawRepo, kind, ref, ...rest] = parts
  if (!owner || !rawRepo) return null
  const repo = rawRepo.replace(/\.git$/i, '')
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return null
  if (!kind) return { owner, repo, ref: null, path: null }
  if ((kind !== 'tree' && kind !== 'blob') || !ref) return null
  let segments = rest.map((s) => decodeURIComponent(s))
  if (segments.some((s) => s === '..' || s === '.')) return null
  if (kind === 'blob') segments = segments.slice(0, -1)
  return { owner, repo, ref: decodeURIComponent(ref), path: segments.length ? segments.join('/') : null }
}
