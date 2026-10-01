export const GREP_DEFAULT_RESULTS = 200
export const GREP_MAX_RESULTS = 1000
export const GLOB_RESULTS = 200
/** Matching files whose change time is read (the listing order is arbitrary past this). */
export const GLOB_SCAN = 2000

function escapeRegex(text: string): string {
  return text.replace(/[.+^$()|\\{}[\]*?]/g, (c) => `\\${c}`)
}

/**
 * Extended regex matching the relative paths a glob stands for: `**` crosses folders, `*`/`?` do not,
 * `{a,b}` and `[...]` as in shells. A pattern without `/` matches the file name at any depth.
 */
export function globToRegex(pattern: string): string {
  const p = pattern.trim().replace(/^\.\//, '')
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') {
          i++
          out += '(.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{' && p.indexOf('}', i) > i) {
      const end = p.indexOf('}', i)
      out += `(${p
        .slice(i + 1, end)
        .split(',')
        .map((alt) => escapeRegex(alt))
        .join('|')})`
      i = end
    } else if (c === '[' && p.indexOf(']', i) > i + 1) {
      const end = p.indexOf(']', i)
      out += p.slice(i, end + 1).replace(/^\[!/, '[^')
      i = end
    } else out += escapeRegex(c)
  }
  return `^${p.includes('/') ? '' : '(.*/)?'}${out}$`
}

/** `mtime<TAB>path` lines, most recent first. */
export function parseGlobOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .flatMap((line) => {
      const tab = line.indexOf('\t')
      if (tab < 0) return []
      const path = line.slice(tab + 1)
      return path ? [{ time: Number(line.slice(0, tab)) || 0, path }] : []
    })
    .sort((a, b) => b.time - a.time || a.path.localeCompare(b.path))
    .map((f) => f.path)
}

/** Result lines of `rg`/`grep`, without the `./` of paths relative to the searched folder. */
export function grepLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, ''))
}
