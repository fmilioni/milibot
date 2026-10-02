import { describe, expect, it } from 'vitest'

import { findExecutable } from '../../src/host/executables'
import { findQemuImg, qemuStatus } from '../../src/host/info'

describe('qemu lookup', () => {
  it('uses the bundled QEMU when it is there', () => {
    const host = { platform: 'darwin', arch: 'arm64', env: { PATH: '' }, homedir: '/Users/ana' }
    const home = '/App/Resources/vm/bin/qemu'
    const files = new Set([
      `${home}/bin/qemu-system-aarch64`,
      `${home}/bin/qemu-img`,
      `${home}/share/qemu/edk2-aarch64-code.fd`,
      `${home}/share/qemu/edk2-arm-vars.fd`,
    ])
    const exists = (f: string) => files.has(f)
    expect(qemuStatus(host.env, host, exists, exists, home)).toEqual({
      found: true,
      path: `${home}/bin/qemu-system-aarch64`,
      binary: 'qemu-system-aarch64',
      firmware: { found: true, tried: expect.arrayContaining([`${home}/share/qemu/edk2-aarch64-code.fd`]) },
    })
    files.delete(`${home}/bin/qemu-img`)
    expect(qemuStatus(host.env, host, exists, exists, home).found).toBe(false)
    expect(findQemuImg(host, home)).toBe(`${home}/bin/qemu-img`)
  })

  it('finds executables on PATH', () => {
    expect(findExecutable('sh', { PATH: '/usr/bin:/bin' })).toMatch(/^\/(usr\/)?bin\/sh$/)
    expect(findExecutable('milibot-missing-binary', { PATH: '/usr/bin:/bin' })).toBeNull()
  })

  it('adds .exe and uses existence on Windows', () => {
    expect(
      findExecutable('milibot-missing-binary', { Path: 'C:\\nothing' }, { platform: 'win32', env: {} }),
    ).toBeNull()
  })

  it('reports qemu as found only with both binaries and the firmware', () => {
    const env = { PATH: '' }
    const status = qemuStatus(env, undefined, undefined, undefined, null)
    const binary = process.arch === 'x64' ? 'qemu-system-x86_64' : 'qemu-system-aarch64'
    expect(status.binary).toBe(process.platform === 'win32' ? `${binary}.exe` : binary)
    const both = Boolean(findExecutable(binary, env) && findExecutable('qemu-img', env))
    expect(status.found).toBe(both && status.firmware?.found === true)
  })

  it('reports the UEFI firmware missing while the binaries are there (Linux without ovmf)', () => {
    const host = { platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin' }, homedir: '/home/ana' }
    const binaries = (file: string) => file.startsWith('/usr/bin/')
    const missing = qemuStatus(host.env, host, binaries, () => false, null)
    expect(missing).toMatchObject({ found: false, path: '/usr/bin/qemu-system-x86_64' })
    expect(missing.firmware?.found).toBe(false)
    expect(missing.firmware?.tried).toContain('/usr/share/OVMF/OVMF_CODE_4M.fd')

    const ovmf = new Set(['/usr/share/OVMF/OVMF_CODE_4M.fd', '/usr/share/OVMF/OVMF_VARS_4M.fd'])
    expect(qemuStatus(host.env, host, binaries, (f) => ovmf.has(f), null)).toMatchObject({
      found: true,
      firmware: { found: true },
    })
    // A code file without its vars template does not count.
    expect(
      qemuStatus(host.env, host, binaries, (f) => f === '/usr/share/OVMF/OVMF_CODE_4M.fd', null).found,
    ).toBe(false)
  })
})
