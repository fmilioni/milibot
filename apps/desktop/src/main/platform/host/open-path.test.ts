import { describe, expect, it } from 'vitest'

import { isExportedFile, isInside, isRevealable, isSafeToOpen } from './open-path'

const file = (mode: number) => () => ({ isFile: () => true, mode })

describe('isSafeToOpen', () => {
  it('opens documents, images and media', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const name of [
        'report.pdf',
        'photo.PNG',
        'notes.md',
        'data.csv',
        'sheet.xlsx',
        'clip.mp4',
        'song.mp3',
      ])
        expect(isSafeToOpen(`/tmp/a/${name}`, file(0o644), platform), `${platform} ${name}`).toBe(true)
    }
  })

  it('shows anything not known to be viewable in the file manager', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const name of ['run.command', 'Setup.pkg', 'tool.AppImage', 'app.desktop', 'install.sh', 'noext'])
        expect(isSafeToOpen(`/tmp/a/${name}`, file(0o644), platform), `${platform} ${name}`).toBe(false)
    }
  })

  it('refuses executable files and anything that is not a regular file (macOS, Linux)', () => {
    expect(isSafeToOpen('/tmp/a/notes.txt', file(0o744), 'linux')).toBe(false)
    expect(isSafeToOpen('/tmp/a/notes.txt', file(0o640), 'linux')).toBe(true)
    expect(isSafeToOpen('/tmp/a/photo.png', file(0o755), 'darwin')).toBe(false)
    expect(isSafeToOpen('/tmp/a/Foo.pdf', () => ({ isFile: () => false, mode: 0o644 }), 'darwin')).toBe(false)
    expect(
      isSafeToOpen(
        '/tmp/a/missing.txt',
        () => {
          throw new Error('ENOENT')
        },
        'darwin',
      ),
    ).toBe(false)
  })

  it('on Windows refuses what runs, mounts or follows links regardless of mode bits', () => {
    for (const name of [
      'a.exe',
      'a.BAT',
      'a.ps1',
      'a.lnk',
      'a.js',
      'a.py',
      'a.chm',
      'a.iso',
      'a.vhdx',
      'a.appref-ms',
      'a.scf',
      'a.docm',
      'a.xls',
      'a.html',
      'a.svg',
    ])
      expect(isSafeToOpen(`C:\\Users\\ana\\${name}`, file(0o644), 'win32'), name).toBe(false)
    // Windows reports files as 0o666/0o777-ish; the mode says nothing about running.
    expect(isSafeToOpen('C:\\Users\\ana\\report.docx', file(0o777), 'win32')).toBe(true)
  })
})

describe('isExportedFile', () => {
  const isFile = () => ({ isFile: () => true })

  it('accepts files the daemon exported for download', () => {
    expect(isExportedFile('/tmp/x/milibot-knowledge/kdoc_1/Contract.pdf', isFile)).toBe(true)
    expect(isExportedFile('/var/t/milibot-attachments/att_1/photo.png', isFile)).toBe(true)
    expect(isExportedFile('/var/t/milibot-vm-files/0a1b2c/NOTES.md', isFile)).toBe(true)
  })

  it('refuses other paths, relative or with dot segments, and folders', () => {
    expect(isExportedFile('/Users/me/.ssh/id_ed25519', isFile)).toBe(false)
    expect(isExportedFile('tmp/milibot-knowledge/kdoc_1/a.pdf', isFile)).toBe(false)
    expect(isExportedFile('/tmp/milibot-knowledge/kdoc_1/../../etc/passwd', isFile)).toBe(false)
    expect(isExportedFile('/tmp/milibot-knowledge/kdoc_1/a', () => ({ isFile: () => false }))).toBe(false)
  })
})

describe('isRevealable', () => {
  const roots = [
    '/Users/ana/Library/Application Support/Milibot',
    '/Applications/Milibot.app/Contents/Resources/assets/skills',
  ]
  const notFile = () => ({ isFile: () => false })

  it('shows the workspace folders, their skills, built-in skills and exported files', () => {
    expect(
      isRevealable('/Users/ana/Library/Application Support/Milibot/workspaces/ws_1', roots, notFile),
    ).toBe(true)
    expect(
      isRevealable('/Users/ana/Library/Application Support/Milibot/workspaces/ws_1/skills', roots, notFile),
    ).toBe(true)
    expect(
      isRevealable('/Applications/Milibot.app/Contents/Resources/assets/skills/pdf', roots, notFile),
    ).toBe(true)
    expect(
      isRevealable('/tmp/x/milibot-attachments/att_1/a.png', roots, () => ({ isFile: () => true })),
    ).toBe(true)
  })

  it('refuses anything else, relative paths and dot segments', () => {
    expect(isRevealable('/Users/ana/.ssh/id_ed25519', roots, notFile)).toBe(false)
    expect(isRevealable('/Users/ana/Library/Application Support/Milibot2', roots, notFile)).toBe(false)
    expect(isRevealable('/Users/ana/Library/Application Support/Milibot/../../.ssh', roots, notFile)).toBe(
      false,
    )
    expect(isRevealable('workspaces/ws_1', roots, notFile)).toBe(false)
  })
})

describe('isInside', () => {
  it('accepts the root itself and what is below it', () => {
    expect(isInside('/data', '/data')).toBe(true)
    expect(isInside('/data/a/..b', '/data')).toBe(true)
    expect(isInside('/data/../etc', '/data')).toBe(false)
    expect(isInside('/database', '/data')).toBe(false)
  })
})
