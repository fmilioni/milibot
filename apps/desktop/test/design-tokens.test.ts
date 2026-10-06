import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../src/renderer/src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// Font sizes, stacking and these colours come from the tokens in the renderer's styles.css.
const FORBIDDEN = [
  { name: 'arbitrary font size', pattern: /(?<![\w-])!?text-\[\d[^\]]*\]/g },
  { name: 'numeric z-index', pattern: /(?<![\w-])!?-?z-(\d+|\[\d+\])(?![\w-])/g },
  {
    name: 'hex scrim or screen colour',
    pattern: /(?<![\w-])(bg|text)-\[#(0D0E11|14161A|1B1E24|3A3F48|ECEDEF|A0A6B1)/gi,
  },
]

describe('design tokens', () => {
  it('no source uses an arbitrary font size, a numeric z-index or a tokenized hex colour', () => {
    const found: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const { name, pattern } of FORBIDDEN) {
        for (const match of text.matchAll(pattern)) found.push(`${relative(ROOT, file)}: ${name} ${match[0]}`)
      }
    }
    expect(found).toEqual([])
  })

  // `hit` grows the pointer target with an absolute ::after: on a wrapper it lies over the control inside
  // and takes its clicks, so it belongs on the control itself.
  it('puts the hit area on the control, never on a wrapper around it', () => {
    const found: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(
        /<(span|div|li|p)\b[^>]*?className=[^>]*?(?<![\w-])hit(?![\w-])[^>]*>/g,
      )) {
        found.push(`${relative(ROOT, file)}: ${match[0].slice(0, 60)}`)
      }
    }
    expect(found).toEqual([])
  })
})
