import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')
/** Code that runs on the user's machine and starts processes (the app, the daemon, its workers, the VM scripts). */
const DIRS = [
  'apps/desktop/src/main',
  'apps/daemon/src',
  'packages/agent/src',
  'packages/shared/src',
  'vm/host/src',
]
const CALL = /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync|fork|exec|execSync)\(/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return /\.(m?[jt]s)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })
}

/** Text of a call from its opening parenthesis to the matching closing one. */
function callText(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

/** Every process a Windows user runs must stay hidden: a console program otherwise opens a window. */
describe('child processes on Windows', () => {
  it('pass windowsHide to every spawn/execFile/fork', () => {
    const missing: string[] = []
    let calls = 0
    for (const file of DIRS.flatMap((dir) => sources(join(root, dir)))) {
      const text = readFileSync(file, 'utf8')
      if (!/child_process/.test(text)) continue
      for (const match of text.matchAll(CALL)) {
        // `.exec(` of regexes and guest clients are not child processes.
        if (text[match.index - 1] === '.') continue
        // Declarations of methods/functions with these names.
        if (
          /(?:private|protected|public|function|async)\s+$/.test(
            text.slice(Math.max(0, match.index - 20), match.index),
          )
        )
          continue
        calls++
        if (!callText(text, match.index + match[0].length - 1).includes('windowsHide')) {
          const line = text.slice(0, match.index).split('\n').length
          missing.push(`${relative(root, file)}:${line} ${match[1]}`)
        }
      }
    }
    expect(calls).toBeGreaterThan(5)
    expect(missing).toEqual([])
  })
})
