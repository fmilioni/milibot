import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') ? [path] : []
  })
}

const files = sources(SRC)

/** The daemon's own modules a source file imports (type-only imports too). */
function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/from '(\.{1,2}\/[^']+)'/g)].flatMap(([, spec]) => {
    const base = resolve(dirname(file), spec as string)
    const found = [`${base}.ts`, join(base, 'index.ts'), base].find((candidate) => files.includes(candidate))
    return found ? [found] : []
  })
}

const rel = (file: string) => relative(SRC, file).replaceAll('\\', '/')
/** Pure data access over a workspace database: what `workspace-db/` may take from the runtime. */
const RUNTIME_STORE = /^runtime\/((.+\/)?store\.ts|workspace-store\.ts)$/

/** `runtime/<domain>/…` → the domain; top-level runtime files belong to none. */
function domainOf(file: string): string | null {
  const parts = rel(file).split('/')
  return parts[0] === 'runtime' && parts.length > 2 ? (parts[1] as string) : null
}

describe('process boundaries', () => {
  it('keeps the supervisor and the runtime apart', () => {
    const crossing = files.flatMap((file) =>
      imports(file)
        .filter((target) =>
          rel(file).startsWith('supervisor/')
            ? rel(target).startsWith('runtime/')
            : rel(file).startsWith('runtime/') && rel(target).startsWith('supervisor/'),
        )
        .map((target) => `${rel(file)} → ${rel(target)}`),
    )
    expect(crossing).toEqual([])
  })

  it('loads no runtime code in the supervisor besides the stores workspace-db uses', () => {
    const seen = new Set<string>()
    const pending = [join(SRC, 'main.ts')]
    while (pending.length) {
      const file = pending.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      pending.push(...imports(file))
    }
    const runtime = [...seen]
      .map(rel)
      .filter((file) => file.startsWith('runtime/') && !RUNTIME_STORE.test(file))
    expect(runtime).toEqual([])
  })
})

describe('runtime domain boundaries', () => {
  it('reaches another domain only through its index.ts (stores may read other stores; composition wires all)', () => {
    const crossing = files.flatMap((file) => {
      const from = domainOf(file)
      if (!from) return []
      return imports(file)
        .filter((target) => {
          const to = domainOf(target)
          if (!to || to === from) return false
          if (rel(target) === `runtime/${to}/index.ts`) return false
          return !(file.endsWith('/store.ts') && target.endsWith('/store.ts'))
        })
        .map((target) => `${rel(file)} → ${rel(target)}`)
    })
    expect(crossing).toEqual([])
  })
})
