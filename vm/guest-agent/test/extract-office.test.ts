import { execFileSync, spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { OFFICE_SCRIPT, parseOfficeOutput } from '../src/extract/office.ts'
import { pptxFixture, xlsxFixture } from './zip-fixture.ts'

const hasPython = spawnSync('python3', ['--version']).status === 0

function runOffice(kind: 'xlsx' | 'pptx', input: Buffer) {
  return parseOfficeOutput(
    execFileSync('python3', ['-I', '-c', OFFICE_SCRIPT, kind], { input, encoding: 'utf8' }),
  )
}

describe.skipIf(!hasPython)('office script (python3)', () => {
  it('reads every sheet as tab-separated rows with shared strings, dates and booleans', () => {
    const out = runOffice('xlsx', xlsxFixture())
    expect(out.title).toBe('Sales 2025')
    expect(out.truncated).toBe(false)
    expect(out.pages).toEqual([
      {
        n: 1,
        title: 'Summary',
        ocr: false,
        text: 'Customer\tTotal\t\tDate\nAna Souza\t1234.5\tTRUE\t2025-01-01\n\t10',
      },
      { n: 2, title: 'Notes', ocr: false, text: 'tab here' },
    ])
  })

  it('reads slides in presentation order with titles, tables and notes', () => {
    const out = runOffice('pptx', pptxFixture())
    expect(out.title).toBe('Plan')
    expect(out.pages).toEqual([
      {
        n: 1,
        title: 'Plan 2026',
        ocr: false,
        text: 'Plan 2026\nFirst point\nSecond point\n\nNotes:\nSpeak slowly',
      },
      { n: 2, title: 'Figures', ocr: false, text: 'Figures\nMonth\tRevenue\nJan\t10' },
    ])
  })

  it('fails with a message for a broken file', () => {
    const result = spawnSync('python3', ['-I', '-c', OFFICE_SCRIPT, 'xlsx'], {
      input: Buffer.from('not a zip'),
    })
    expect(result.status).toBe(3)
    expect(result.stderr.toString()).toContain('BadZipFile')
  })
})
