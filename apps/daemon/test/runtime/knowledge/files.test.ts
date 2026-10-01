import { describe, expect, it } from 'vitest'

import { sniffFile } from '../../../src/runtime/files/sniff'
import { isLegacyOfficeName, kindFromName, kindOf, noteFileName } from '../../../src/runtime/knowledge/files'
import { vmPathOf } from '../../../src/runtime/knowledge/intake'
import { splitParts } from '../../../src/runtime/knowledge/service'

describe('files', () => {
  it('detects kinds and refuses binaries', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 ...')
    expect(kindOf('x.pdf', sniffFile('x.pdf', pdf))).toEqual({ kind: 'pdf' })
    const text = new TextEncoder().encode('a,b\n1,2')
    expect(kindOf('data.csv', sniffFile('data.csv', text))).toEqual({ kind: 'csv' })
    expect(kindOf('app.ts', sniffFile('app.ts', text))).toEqual({ kind: 'code' })
    expect(kindOf('notes.md', sniffFile('notes.md', text))).toEqual({ kind: 'markdown' })
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])
    expect(kindOf('bin', sniffFile('bin', elf))).toEqual({ unsupported: 'ELF executable' })
    const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    expect(kindOf('minutes.doc', sniffFile('minutes.doc', ole2))).toEqual({ kind: 'docx' })
    expect(kindOf('sales.xls', sniffFile('sales.xls', ole2))).toEqual({ kind: 'xlsx' })
    expect(kindOf('plan.pps', sniffFile('plan.pps', ole2))).toEqual({ kind: 'pptx' })
    expect(kindFromName('old.PPT')).toBe('pptx')
    expect(isLegacyOfficeName('table.ods')).toBe(true)
    expect(isLegacyOfficeName('table.xlsx')).toBe(false)
    expect(noteFileName('Runbook: deploy/prod')).toBe('Runbook- deploy-prod.md')
    expect(vmPathOf('docs/a.pdf')).toBe('/workspace/docs/a.pdf')
    expect(vmPathOf('/etc/passwd')).toBeNull()
    expect(vmPathOf('/workspace/../etc/passwd')).toBeNull()
    expect(splitParts('a\n\nb\n\nc', 3)).toEqual(['a', 'b', 'c'])
  })
})
