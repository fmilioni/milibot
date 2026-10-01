import { describe, expect, it } from 'vitest'

import { daemonEnvironment, packagedDaemon, pathKey } from './command'

describe('packagedDaemon', () => {
  it('Windows: runs the bundled node.exe with the Node VM scripts', () => {
    const resources = 'C:\\Users\\ana\\AppData\\Local\\Programs\\Milibot\\resources'
    const cmd = packagedDaemon({
      platform: 'win32',
      resourcesPath: resources,
      env: { Path: 'C:\\Windows\\system32', ProgramFiles: 'C:\\Program Files' },
    })
    expect(cmd.command).toBe(`${resources}\\node\\node.exe`)
    expect(cmd.args).toEqual([`${resources}\\daemon\\main.js`])
    expect(cmd.cwd).toBe(`${resources}\\daemon`)
    expect(cmd.env.MILIBOT_VM_CLI).toBe(`${resources}\\vm\\scripts\\workspace-vm.mjs`)
    expect(cmd.env.MILIBOT_VM_BUILD).toBe(`${resources}\\vm\\scripts\\build-golden.mjs`)
    // Same PATH key as the parent, the bundled Node first and QEMU's install folder last.
    expect(Object.keys(cmd.env)).not.toContain('PATH')
    expect(cmd.env.Path).toBe(`${resources}\\node;C:\\Windows\\system32;C:\\Program Files\\qemu`)
  })

  it('macOS: the bundled Node and the Node VM scripts, Homebrew on the PATH', () => {
    const resources = '/Applications/Milibot.app/Contents/Resources'
    const cmd = packagedDaemon({
      platform: 'darwin',
      resourcesPath: resources,
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(cmd.command).toBe(`${resources}/node/bin/node`)
    expect(cmd.args).toEqual([`${resources}/daemon/main.js`])
    expect(cmd.cwd).toBe(`${resources}/daemon`)
    expect(cmd.env.MILIBOT_VM_CLI).toBe(`${resources}/vm/scripts/workspace-vm.mjs`)
    expect(cmd.env.MILIBOT_VM_BUILD).toBe(`${resources}/vm/scripts/build-golden.mjs`)
    expect(cmd.env.PATH).toBe(
      `${resources}/node/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/sbin:/sbin`,
    )
  })

  it('Linux (.deb and AppImage mount alike): no Homebrew, no bash wrappers', () => {
    const resources = '/tmp/.mount_MilibotAbc/resources'
    const cmd = packagedDaemon({ platform: 'linux', resourcesPath: resources, env: { PATH: '/usr/bin' } })
    expect(cmd.command).toBe(`${resources}/node/bin/node`)
    expect(cmd.env.MILIBOT_VM_CLI).toBe(`${resources}/vm/scripts/workspace-vm.mjs`)
    expect(cmd.env.PATH).toBe(
      `${resources}/node/bin:/usr/bin:/usr/local/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`,
    )
  })

  it('keeps explicit VM script overrides', () => {
    const cmd = packagedDaemon({
      platform: 'win32',
      resourcesPath: 'C:\\r',
      env: { MILIBOT_VM_CLI: 'D:\\vm.mjs', PATH: '' },
    })
    expect(cmd.env.MILIBOT_VM_CLI).toBe('D:\\vm.mjs')
    expect(Object.keys(cmd.env)).toContain('PATH')
  })
})

describe('pathKey', () => {
  it('reuses the spelling the environment has, else the platform default', () => {
    expect(pathKey({ Path: 'x' }, 'win32')).toBe('Path')
    expect(pathKey({}, 'win32')).toBe('Path')
    expect(pathKey({}, 'linux')).toBe('PATH')
  })
})

describe('daemonEnvironment', () => {
  it('drops Electron variables and adds the command variables on top', () => {
    const env = daemonEnvironment(
      { HOME: '/home/ana', ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin', UNSET: undefined },
      { PATH: '/opt/node/bin:/usr/bin', MILIBOT_DATA_DIR: '/data' },
    )
    expect(env).toEqual({ HOME: '/home/ana', PATH: '/opt/node/bin:/usr/bin', MILIBOT_DATA_DIR: '/data' })
  })

  it('AppImage: drops its variables and restores what it changed before the app started', () => {
    const env = daemonEnvironment(
      {
        HOME: '/home/ana',
        APPIMAGE: '/home/ana/Milibot.AppImage',
        APPDIR: '/tmp/.mount_Milibot',
        ARGV0: 'Milibot.AppImage',
        OWD: '/home/ana',
        LD_LIBRARY_PATH: '/tmp/.mount_Milibot/usr/lib:/opt/cuda/lib',
        APPIMAGE_ORIGINAL_LD_LIBRARY_PATH: '/opt/cuda/lib',
        GIO_MODULE_DIR: '/tmp/.mount_Milibot/usr/lib/gio',
        APPIMAGE_ORIGINAL_GIO_MODULE_DIR: '',
      },
      {},
    )
    expect(env).toEqual({ HOME: '/home/ana', LD_LIBRARY_PATH: '/opt/cuda/lib' })
  })

  it('AppImage without saved originals: strips library paths inside the mount', () => {
    const inMount = daemonEnvironment(
      { APPDIR: '/tmp/.mount_Milibot', LD_LIBRARY_PATH: '/tmp/.mount_Milibot/usr/lib' },
      {},
    )
    expect(inMount).toEqual({})
    const mixed = daemonEnvironment(
      { APPDIR: '/tmp/.mount_Milibot', LD_LIBRARY_PATH: '/tmp/.mount_Milibot/usr/lib:/opt/lib' },
      {},
    )
    expect(mixed).toEqual({ LD_LIBRARY_PATH: '/opt/lib' })
  })

  it('leaves LD_LIBRARY_PATH alone outside an AppImage', () => {
    expect(daemonEnvironment({ LD_LIBRARY_PATH: '/opt/lib' }, {})).toEqual({ LD_LIBRARY_PATH: '/opt/lib' })
  })
})
