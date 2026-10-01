import { describe, expect, it } from 'vitest'

import { type CommandRunner, parseAptStatus } from '../src/apt.ts'
import { createOfficeInstaller, installProgress } from '../src/extract/libreoffice.ts'
import { createExtractTools, type ExtractTool } from '../src/extract/tools.ts'

const all = (value: boolean): Record<ExtractTool, boolean> => ({
  pdftotext: value,
  pdftoppm: value,
  pdfinfo: value,
  pandoc: value,
  tesseract: value,
  ocrLanguages: value,
  python3: true,
  soffice: false,
})

describe('extraction tools', () => {
  it('reports the missing tools a kind needs, never for plain text', () => {
    const tools = createExtractTools(() => ({ ...all(true), tesseract: false, python3: false }))
    tools.ensure('csv')
    tools.ensure('docx')
    expect(() => tools.ensure('image')).toThrow(
      expect.objectContaining({ code: 'tools_missing', message: expect.stringContaining('tesseract') }),
    )
    expect(() => tools.ensure('xlsx')).toThrow(
      expect.objectContaining({ code: 'tools_missing', message: expect.stringContaining('python3') }),
    )
  })
})

describe('old Office formats', () => {
  it('needs LibreOffice, which an extraction never installs', () => {
    const tools = createExtractTools(() => ({ ...all(true), soffice: false }))
    expect(() => tools.ensure('doc')).toThrow(expect.objectContaining({ code: 'office_missing' }))
    expect(() => tools.ensure('ods')).toThrow(expect.objectContaining({ code: 'office_missing' }))
    tools.ensure('docx')
    createExtractTools(() => ({ ...all(true), soffice: true })).ensure('ppt')
  })

  it('reads apt status lines and maps them to one progress bar', () => {
    expect(parseAptStatus('dlstatus:12:45.5000:Retrieving file 12 of 85')).toEqual({
      type: 'dlstatus',
      percent: 45.5,
      message: 'Retrieving file 12 of 85',
    })
    expect(parseAptStatus('pmstatus:libc6:arm64:62.1:Unpacking libc6:arm64 (arm64)')).toMatchObject({
      type: 'pmstatus',
      percent: 62.1,
    })
    expect(parseAptStatus('Reading package lists...')).toBeNull()
    expect(installProgress('preparing', 50)).toBe(0.05)
    expect(installProgress('downloading', 0)).toBe(0.1)
    expect(installProgress('downloading', 100)).toBe(0.5)
    expect(installProgress('installing', 50)).toBe(0.75)
    expect(installProgress('removing', 30)).toBe(0.3)
  })

  function fakeApt(options: { lists?: boolean; failInstall?: number; failUpdate?: boolean } = {}) {
    let soffice = false
    let lists = options.lists ?? true
    let installFailures = options.failInstall ?? 0
    const calls: string[] = []
    const seen: number[] = []
    let installer: ReturnType<typeof createOfficeInstaller> | null = null
    const run: CommandRunner = async (file, args, onStatus) => {
      const verb = file === 'apt-get' ? args.find((a) => !a.startsWith('-') && !a.includes('=')) : file
      calls.push(`${file} ${verb}`)
      if (file === 'apt-get' && verb === 'update') {
        if (options.failUpdate) return { code: 100, output: 'Temporary failure resolving deb.debian.org' }
        lists = true
        return { code: 0, output: '' }
      }
      if (file === 'apt-get' && verb === 'install') {
        if (installFailures-- > 0)
          return { code: 100, output: 'E: Failed to fetch libreoffice-core-nogui 404 Not Found' }
        onStatus?.('dlstatus:1:0.0000:Retrieving file 1 of 83')
        onStatus?.('dlstatus:83:100.0000:Retrieving file 83 of 83')
        seen.push(installer!.status().progress!)
        onStatus?.('pmstatus:ure:50.0:Unpacking ure (arm64)')
        seen.push(installer!.status().progress!)
        soffice = true
        return { code: 0, output: '' }
      }
      if (file === 'apt-get' && verb === 'purge') {
        onStatus?.('pmstatus:ure:40.0:Removing ure (arm64)')
        seen.push(installer!.status().progress!)
        soffice = false
        return { code: 0, output: '' }
      }
      return { code: 0, output: '' }
    }
    installer = createOfficeInstaller({ run, installed: () => soffice, hasLists: () => lists })
    return { installer, calls, seen }
  }

  it('installs with progress, updating the package lists first only when there are none', async () => {
    const fresh = fakeApt({ lists: false })
    expect(fresh.installer.install()).toMatchObject({ state: 'installing', phase: 'preparing', progress: 0 })
    await fresh.installer.idle()
    expect(fresh.calls).toEqual(['dpkg dpkg', 'apt-get update', 'apt-get install', 'apt-get clean'])
    expect(fresh.seen).toEqual([0.5, 0.75])
    expect(fresh.installer.status()).toEqual({
      state: 'installed',
      installed: true,
      phase: null,
      progress: null,
      error: null,
      failed: null,
    })
    fresh.installer.install()
    await fresh.installer.idle()
    expect(fresh.calls).toHaveLength(4)

    const stale = fakeApt({ failInstall: 1 })
    stale.installer.install()
    await stale.installer.idle()
    expect(stale.calls).toEqual([
      'dpkg dpkg',
      'apt-get install',
      'apt-get update',
      'apt-get install',
      'apt-get clean',
    ])
    expect(stale.installer.status().state).toBe('installed')
  })

  it('reports a failed install and tries again when asked', async () => {
    const offline = fakeApt({ lists: false, failUpdate: true })
    offline.installer.install()
    await offline.installer.idle()
    expect(offline.installer.status()).toMatchObject({
      state: 'error',
      failed: 'install',
      error: expect.stringContaining('no network'),
    })
    expect(offline.installer.install().state).toBe('installing')
    await offline.installer.idle()
    expect(offline.installer.status().state).toBe('error')
  })

  it('removes and trims, and the last request wins', async () => {
    const apt = fakeApt()
    apt.installer.install()
    apt.installer.remove()
    apt.installer.install()
    await apt.installer.idle()
    expect(apt.installer.status().state).toBe('installed')
    expect(apt.calls.filter((c) => c === 'apt-get install')).toHaveLength(1)
    expect(apt.installer.remove()).toMatchObject({ state: 'removing', phase: 'removing' })
    await apt.installer.idle()
    expect(apt.calls.slice(-2)).toEqual(['apt-get purge', 'fstrim fstrim'])
    expect(apt.seen.at(-1)).toBe(0.4)
    expect(apt.installer.status()).toMatchObject({ state: 'absent', installed: false })
  })
})
