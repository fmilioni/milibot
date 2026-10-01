import { describe, expect, it } from 'vitest'

import { exportFileName, exportScale, framesPrintDocument, MAX_EXPORT_SIDE, uniqueBaseNames } from './logic'

describe('design exports', () => {
  it('keeps the requested PNG scale unless the image gets too big', () => {
    expect(exportScale(1280, 800, 2)).toBe(2)
    expect(exportScale(1280, 800, 9)).toBe(3)
    expect(exportScale(1440, 9000, 3)).toBeCloseTo(MAX_EXPORT_SIDE / 9000)
    const big = exportScale(10_000, 10_000, 3)
    expect(10_000 * big).toBeLessThanOrEqual(MAX_EXPORT_SIDE)
  })

  it('names files after the design or frame', () => {
    expect(exportFileName('Dashboard (Night)', 'png')).toBe('Dashboard (Night).png')
    expect(exportFileName('a/b: c?', 'pdf')).toBe('a-b- c.pdf')
    expect(exportFileName('  ', 'pdf')).toBe('design.pdf')
  })

  it('gives frames saved together distinct file names', () => {
    expect(uniqueBaseNames(['Home', 'home', 'a/b', 'Home', 'Home (2)'])).toEqual([
      'Home',
      'home (2)',
      'a-b',
      'Home (3)',
      'Home (2) (2)',
    ])
  })

  it('prints each frame on its own named page, in an iframe of its own', () => {
    const doc = framesPrintDocument([
      { name: 'A', html: '<p class="x">"A" & B</p>', width: 1280, height: 800 },
      { name: 'B', html: '<p>B</p>', width: 390, height: null },
    ])
    expect(doc).toContain('srcdoc="<p class=&quot;x&quot;>&quot;A&quot; &amp; B</p>"')
    expect(doc).toContain('section.p0 { page: p0 }')
    expect(doc).toContain('section.p1 { page: p1 }')
    expect(doc).toContain('data-width="390" data-height="0"')
    expect(doc.match(/<iframe /g)).toHaveLength(2)
  })
})
