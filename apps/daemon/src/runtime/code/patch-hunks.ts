/**
 * Models often write hunks without line ranges (a bare `@@`, or Codex's `*** Begin Patch` format), which
 * `git apply` refuses. These are placed by their context and removed lines and given real ranges.
 */

const RANGED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

export class PatchError extends Error {
  constructor(
    message: string,
    /** Path (relative to the patch's folder) of a file the patch changes that does not exist. */
    readonly missingPath: string | null = null,
  ) {
    super(message)
  }
}

interface Hunk {
  header: number
  /** Body lines are `[start, end)`; `stop` also covers the blank lines that follow it. */
  start: number
  end: number
  stop: number
}

interface Section {
  oldPath: string | null
  newPath: string | null
  hasHeader: boolean
  hunks: Hunk[]
}

const isBare = (header: string) => !RANGED_HUNK.test(header)

function headerPath(raw: string): string | null {
  const path = (raw.split('\t')[0] ?? '').trim().replace(/^"(.*)"$/, '$1')
  return path === '/dev/null' ? null : path
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\'
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = []
  let section: Section | null = null
  let hunk: Hunk | null = null
  const close = (stop: number) => {
    if (!hunk) return
    let end = stop
    while (end > hunk.start && lines[end - 1] === '') end--
    hunk.end = end
    hunk.stop = stop
    hunk = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const fileHeader = line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')
    if (line.startsWith('diff --git ') || fileHeader) {
      close(i)
      if (line.startsWith('diff --git ') || !section || section.hasHeader || section.hunks.length) {
        section = { oldPath: null, newPath: null, hasHeader: false, hunks: [] }
        sections.push(section)
      }
      if (fileHeader) {
        section.oldPath = headerPath(line.slice(4))
        section.newPath = headerPath((lines[i + 1] as string).slice(4))
        section.hasHeader = true
        i++
      }
      continue
    }
    if (line.startsWith('@@') && section) {
      close(i)
      hunk = { header: i, start: i + 1, end: i + 1, stop: i + 1 }
      section.hunks.push(hunk)
      continue
    }
    if (hunk && !isBodyLine(line)) close(i)
  }
  close(lines.length)
  return sections
}

/**
 * The text after a bare `@@` (Codex: a line the hunk comes after, such as its function's signature); the
 * search starts there when the file has that line.
 */
function anchorOf(header: string): string {
  return header
    .slice(2)
    .replace(/@@\s*$/, '')
    .trim()
}

function fileLinesOf(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function findAt(fileLines: string[], old: string[], from: number, loose: boolean): number[] {
  const same = loose
    ? (a: string, b: string) => a.trimEnd() === b.trimEnd()
    : (a: string, b: string) => a === b
  const hits: number[] = []
  for (let p = from; p + old.length <= fileLines.length && hits.length < 2; p++) {
    if (old.every((line, k) => same(fileLines[p + k] as string, line))) hits.push(p)
  }
  return hits
}

async function readSectionFile(
  path: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<{ path: string; content: string }> {
  const slash = path.indexOf('/')
  const candidates = slash > 0 ? [path.slice(slash + 1), path] : [path]
  for (const candidate of candidates) {
    const content = await readFile(candidate)
    if (content !== null) return { path: candidate, content }
  }
  const missing = /^[ab]\//.test(path) ? path.slice(2) : path
  throw new PatchError(`${missing} does not exist`, missing)
}

/**
 * The patch with every hunk of a file that has a bare `@@` placed in that file: its context and removed
 * lines must match once (exactly, else ignoring trailing whitespace), after the previous hunk. Other files
 * are left as written. `readFile` gets paths as written in the patch (with and without the first folder,
 * like `git apply -p1`/`-p0`) and returns null for a missing file.
 */
export async function placeBareHunks(
  patch: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<string> {
  const lines = patch.split('\n')
  const sections = parseSections(lines)
  if (!sections.some((s) => s.hunks.some((h) => isBare(lines[h.header] as string)))) return patch
  const rewritten = new Map<number, { lines: string[]; stop: number }>()
  let n = 0
  for (const section of sections) {
    if (!section.hunks.some((h) => isBare(lines[h.header] as string))) {
      n += section.hunks.length
      continue
    }
    const file =
      section.oldPath === null
        ? { path: (section.newPath ?? '?').replace(/^b\//, ''), content: '' }
        : await readSectionFile(section.oldPath, readFile)
    const fileLines = fileLinesOf(file.content)
    let cursor = 0
    let delta = 0
    for (const hunk of section.hunks) {
      n++
      const where = `hunk ${n} (${file.path})`
      const header = lines[hunk.header] as string
      let body = lines.slice(hunk.start, hunk.end)
      if (body.length === 0 && section.newPath === null) body = fileLines.map((l) => `-${l}`)
      const old = body.filter((l) => l[0] !== '+' && l[0] !== '\\').map((l) => l.slice(1))
      const added = body.filter((l) => l[0] !== '-' && l[0] !== '\\').length
      let at: number
      if (old.length === 0) {
        if (fileLines.length > 0)
          throw new PatchError(
            `${where}: no context or removed lines to place it; include lines around the change`,
          )
        at = 0
      } else {
        const anchor = isBare(header) ? anchorOf(header) : ''
        const anchored = anchor ? fileLines.findIndex((l, i) => i >= cursor && l.trim() === anchor) : -1
        const from = anchored >= 0 ? anchored : cursor
        let hits = findAt(fileLines, old, from, false)
        if (hits.length === 0) hits = findAt(fileLines, old, from, true)
        if (hits.length === 0)
          throw new PatchError(
            `${where}: context not found${cursor > 0 ? ' after the previous hunk' : ''}; the context and removed lines must match the file exactly`,
          )
        if (hits.length > 1)
          throw new PatchError(`${where}: context matches more than once; add more context lines`)
        at = hits[0] as number
      }
      const oldStart = old.length ? at + 1 : at
      const newStart = added ? at + 1 + delta : at + delta
      const out = [`@@ -${oldStart},${old.length} +${newStart},${added} @@`]
      let k = 0
      for (const line of body) {
        if (line[0] === '+' || line[0] === '\\') out.push(line)
        else out.push(`${line[0] === '-' ? '-' : ' '}${fileLines[at + k++]}`)
      }
      rewritten.set(hunk.header, { lines: out, stop: hunk.stop })
      cursor = at + old.length
      delta += added - old.length
    }
  }
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const hunk = rewritten.get(i)
    if (!hunk) {
      out.push(lines[i] as string)
      continue
    }
    out.push(...hunk.lines)
    i = hunk.stop - 1
  }
  const text = out.join('\n')
  return patch.endsWith('\n') && !text.endsWith('\n') ? `${text}\n` : text
}

/**
 * A Codex `*** Begin Patch` patch as a unified diff with bare hunks (Update/Add/Delete File); anything else
 * is returned unchanged.
 */
export function fromCodexPatch(patch: string): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  if (lines.find((l) => l.trim() !== '')?.trim() !== '*** Begin Patch') return patch
  const out: string[] = []
  let needsHunk = false
  for (const line of lines) {
    const marker = line.trim()
    if (marker === '*** Begin Patch' || marker === '*** End Patch' || marker === '*** End of File') continue
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(marker)
    if (file) {
      const path = (file[2] as string).trim()
      if (file[1] === 'Update') out.push(`--- a/${path}`, `+++ b/${path}`)
      else if (file[1] === 'Add') out.push('--- /dev/null', `+++ b/${path}`, '@@')
      else out.push(`--- a/${path}`, '+++ /dev/null', '@@')
      needsHunk = file[1] === 'Update'
      continue
    }
    if (marker.startsWith('*** Move to:'))
      throw new PatchError(
        '"*** Move to" is not supported: rename the file with bash (git mv), then patch it',
      )
    if (needsHunk) {
      if (line === '') continue
      if (!line.startsWith('@@')) out.push('@@')
      needsHunk = false
    }
    out.push(line)
  }
  return out.join('\n')
}
