import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const repo = join(import.meta.dirname, '..', '..', '..')

type Env = Record<string, string>

interface PackageConfigModule {
  UPDATE_FEED: { provider: string; owner: string; repo: string }
  autoUpdateEnabled(input: { platform: string; env: Env }): boolean
  appPackageJson(
    root: { version: string; homepage: string },
    options: { autoUpdate: boolean },
  ): { version: string; milibot: { autoUpdate: boolean } }
  buildConfig(input: Record<string, unknown>): {
    publish: unknown
    mac: { artifactName: string }
    dmg: { artifactName: string }
  }
}

const config = (await import(
  pathToFileURL(join(repo, 'scripts', 'package', 'config.mjs')).href
)) as PackageConfigModule

function build(platform: string, env: Env = {}) {
  return config.buildConfig({
    ctx: {
      platform,
      arch: 'arm64',
      cross: false,
      env,
      root: repo,
      desktop: join(repo, 'apps', 'desktop'),
      daemon: join(repo, 'apps', 'daemon'),
      distDir: 'dist',
      stage: 'stage',
    },
    natives: { onnxLibs: [], interDir: 'inter', keyring: null },
  })
}

describe('update feed of the package', () => {
  it('points every build at the repository releases on GitHub', () => {
    expect(config.UPDATE_FEED).toEqual({ provider: 'github', owner: 'fmilioni', repo: 'milibot' })
    for (const platform of ['darwin', 'linux', 'win32'])
      expect(build(platform).publish).toBe(config.UPDATE_FEED)
  })

  it('names the macOS zip apart from the dmg', () => {
    const { mac, dmg } = build('darwin')
    expect(mac.artifactName).toBe('Milibot-${version}-${arch}-mac.${ext}')
    expect(dmg.artifactName).toBe('Milibot-${version}-${arch}.${ext}')
  })

  it('turns the updater on for Windows and Linux, and on macOS only with a Developer ID', () => {
    expect(config.autoUpdateEnabled({ platform: 'win32', env: {} })).toBe(true)
    expect(config.autoUpdateEnabled({ platform: 'linux', env: {} })).toBe(true)
    expect(config.autoUpdateEnabled({ platform: 'darwin', env: {} })).toBe(false)
    expect(config.autoUpdateEnabled({ platform: 'darwin', env: { CSC_LINK: 'cert.p12' } })).toBe(true)
    expect(config.autoUpdateEnabled({ platform: 'darwin', env: { CSC_NAME: 'Developer ID' } })).toBe(true)
  })

  it('writes the switch into the packaged package.json', () => {
    const root = { version: '0.5.0', homepage: 'https://github.com/fmilioni/milibot' }
    expect(config.appPackageJson(root, { autoUpdate: true })).toMatchObject({
      version: '0.5.0',
      milibot: { autoUpdate: true },
    })
    expect(config.appPackageJson(root, { autoUpdate: false }).milibot.autoUpdate).toBe(false)
  })
})
