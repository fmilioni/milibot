import type { TaskStatus } from '@milibot/shared'

type PrAction = 'create' | 'merge' | 'ready' | 'close' | 'reopen'

export interface PrCommand {
  action: PrAction
  url: string | null
  /** `owner/name`. */
  repo: string | null
  number: number | null
  title: string | null
  branch: string | null
  draft: boolean
  /** `gh pr merge --auto`: merges later, when the checks pass. */
  auto: boolean
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const GH_PR = /(?:^|[\s;&|(`$])gh\s+pr\s+(create|merge|ready|close|reopen)\b/

/**
 * Splits the command after `gh pr <sub>` into words the way a shell would (quotes, backslashes),
 * stopping at the end of that command (`&&`, `||`, `;`, `|`, newline outside quotes).
 */
export function shellWords(text: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
      else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (c === '\\' && i + 1 < text.length) {
      current += text[++i]
      started = true
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === ')') break
    if (c === ' ' || c === '\t') {
      if (started) words.push(current)
      current = ''
      started = false
      continue
    }
    current += c
    started = true
  }
  if (started) words.push(current)
  return words
}

function flag(words: string[], names: string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    for (const name of names) {
      if (word === name) return words[i + 1] ?? null
      if (name.startsWith('--') && word.startsWith(`${name}=`)) return word.slice(name.length + 1)
    }
  }
  return null
}

const VALUE_FLAGS = new Set([
  '-t',
  '--title',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-B',
  '--base',
  '-H',
  '--head',
  '-R',
  '--repo',
  '-r',
  '--reviewer',
  '-a',
  '--assignee',
  '-l',
  '--label',
  '-m',
  '--milestone',
  '-p',
  '--project',
  '--subject',
  '--match-head-commit',
  '-A',
  '--author-email',
  '-c',
  '--comment',
])

function firstPositional(words: string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if (word.startsWith('-')) {
      if (VALUE_FLAGS.has(word)) i++
      continue
    }
    return word
  }
  return null
}

function lastPrUrl(text: string): { url: string; repo: string; number: number } | null {
  let found: { url: string; repo: string; number: number } | null = null
  for (const match of text.matchAll(PR_URL))
    found = { url: match[0], repo: match[1] as string, number: Number(match[2]) }
  return found
}

/**
 * A `gh pr create|merge|ready|close|reopen` in a shell command (bash tool or a CLI engine's shell) and
 * what its output says about the pull request. Null when the command does not touch a PR, or it
 * failed without naming one.
 */
export function detectPrCommand(command: string, output: string, failed = false): PrCommand | null {
  const match = GH_PR.exec(command)
  if (!match) return null
  const action = match[1] as PrAction
  const words = shellWords(command.slice((match.index ?? 0) + match[0].length))
  const fromOutput = lastPrUrl(output)
  if (failed && !fromOutput) return null
  const target = action === 'create' ? null : firstPositional(words)
  const fromTarget = target ? lastPrUrl(target) : null
  const url = fromOutput?.url ?? fromTarget?.url ?? null
  const repoFlag = flag(words, ['-R', '--repo'])
  const outputNumber = /pull request ([\w.-]+\/[\w.-]+)?#(\d+)/i.exec(output)
  const repo =
    fromOutput?.repo ??
    fromTarget?.repo ??
    (repoFlag?.includes('/') ? repoFlag : null) ??
    outputNumber?.[1] ??
    null
  const number =
    fromOutput?.number ??
    fromTarget?.number ??
    (target && /^#?\d+$/.test(target) ? Number(target.replace('#', '')) : null) ??
    (outputNumber ? Number(outputNumber[2]) : null)
  const branch =
    flag(words, ['-H', '--head']) ?? (target && !/^#?\d+$/.test(target) && !fromTarget ? target : null)
  if (!url && number === null) return null
  return {
    action,
    url,
    repo,
    number,
    title: action === 'create' ? flag(words, ['-t', '--title']) : null,
    branch,
    draft: words.includes('--draft') || words.includes('-d'),
    auto: words.includes('--auto'),
  }
}

/** Card status right after the command, when the PR itself cannot be read. */
export function statusAfter(command: PrCommand): TaskStatus {
  switch (command.action) {
    case 'create':
      return command.draft ? 'open' : 'review'
    case 'merge':
      return command.auto ? 'review' : 'done'
    case 'close':
      return 'failed'
    default:
      return 'review'
  }
}

export interface GhPrView {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  headRefName: string
}

/** Parses `gh pr view --json number,title,url,state,isDraft,headRefName`. */
export function parseGhPrView(stdout: string): GhPrView | null {
  try {
    const value = JSON.parse(stdout) as Partial<GhPrView>
    if (typeof value.url !== 'string' || typeof value.number !== 'number') return null
    return {
      number: value.number,
      title: typeof value.title === 'string' ? value.title : '',
      url: value.url,
      state: value.state === 'MERGED' || value.state === 'CLOSED' ? value.state : 'OPEN',
      isDraft: value.isDraft === true,
      headRefName: typeof value.headRefName === 'string' ? value.headRefName : '',
    }
  } catch {
    return null
  }
}

export function statusOfPr(view: Pick<GhPrView, 'state' | 'isDraft'>): TaskStatus {
  if (view.state === 'MERGED') return 'done'
  if (view.state === 'CLOSED') return 'failed'
  return view.isDraft ? 'open' : 'review'
}
