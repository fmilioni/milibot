// Runs in the VM (`node -e`, as the bot): the CLAUDE.md/AGENTS.md of the repository of each folder in the JSON
// request on stdin (`{root, dirs, maxBytes}`), from the repository root down to the folder, and prints one JSON
// line `{files: [{path, bytes, truncated, content, sameAs}]}`. The repository root is the closest folder with a `.git`
// (a file in worktrees), never above `root`; a folder outside a repository gives nothing. In one folder, a
// CLAUDE.md and an AGENTS.md that are the same file (symlink) or have the same text count once (CLAUDE.md, with
// the other path in `sameAs`).
// Content past `maxBytes` is cut at the last line end.
const fs = require('node:fs'),
  path = require('node:path')
const NAMES = ['CLAUDE.md', 'AGENTS.md']
let raw = ''
process.stdin
  .on('data', (c) => {
    raw += c
  })
  .on('end', () => {
    process.stdout.write(JSON.stringify(main(JSON.parse(raw))) + '\n')
  })

function main(input) {
  const root = path.resolve(String(input.root))
  const maxBytes = Number(input.maxBytes)
  const inside = (p) => p === root || p.startsWith(root + '/')
  const seen = new Set()
  const files = []
  for (const given of input.dirs) {
    const dir = existingDir(path.resolve(root, String(given)), inside)
    const top = dir && repoRoot(dir, root, inside)
    if (!top) continue
    const rel = path.relative(top, dir)
    let cur = top
    for (const part of ['', ...(rel ? rel.split('/') : [])]) {
      cur = part ? path.join(cur, part) : cur
      for (const file of folderFiles(cur)) {
        if (seen.has(file.path)) continue
        seen.add(file.path)
        files.push(clip(file, maxBytes))
      }
    }
  }
  return { files }
}

/** The folder itself, the folder of a file, or the closest existing parent (a file about to be written). */
function existingDir(p, inside) {
  let cur = p
  while (inside(cur)) {
    try {
      return fs.statSync(cur).isDirectory() ? cur : path.dirname(cur)
    } catch {
      cur = path.dirname(cur)
    }
  }
  return null
}

function repoRoot(dir, root, inside) {
  for (let cur = dir; inside(cur); cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    if (cur === root) break
  }
  return null
}

function folderFiles(dir) {
  const found = []
  for (const name of NAMES) {
    const file = path.join(dir, name)
    try {
      if (!fs.statSync(file).isFile()) continue
      found.push({ path: file, real: fs.realpathSync(file), buf: fs.readFileSync(file) })
    } catch {
      // missing or unreadable for this user
    }
  }
  const [first, second] = found
  if (
    first &&
    second &&
    (first.real === second.real || first.buf.toString('utf8').trim() === second.buf.toString('utf8').trim())
  )
    return [{ ...first, sameAs: [second.path] }]
  return found
}

function clip(file, maxBytes) {
  const bytes = file.buf.length
  const sameAs = file.sameAs || []
  if (bytes <= maxBytes)
    return { path: file.path, bytes, truncated: false, content: file.buf.toString('utf8'), sameAs }
  let cut = file.buf.subarray(0, maxBytes)
  const end = cut.lastIndexOf(10)
  if (end > 0) cut = cut.subarray(0, end + 1)
  return { path: file.path, bytes, truncated: true, content: cut.toString('utf8'), sameAs }
}
