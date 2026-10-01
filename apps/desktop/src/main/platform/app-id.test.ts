import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { APP_ID, STOP_DAEMON_FLAG } from './app-id'
import { RUN_KEY, RUN_VALUE } from './login-item/windows'

const repo = join(import.meta.dirname, '..', '..', '..', '..', '..')

interface PackageConfigModule {
  buildConfig(input: Record<string, unknown>): { appId: string; nsis: { include: string } }
}

describe('packaging contract', () => {
  it('the installer appId is the AppUserModelID', async () => {
    const { buildConfig } = (await import(
      pathToFileURL(join(repo, 'scripts', 'package', 'config.mjs')).href
    )) as PackageConfigModule
    const config = buildConfig({
      ctx: {
        platform: 'win32',
        arch: 'x64',
        cross: false,
        env: {},
        root: repo,
        desktop: join(repo, 'apps', 'desktop'),
        daemon: join(repo, 'apps', 'daemon'),
        distDir: 'dist',
        stage: 'stage',
      },
      natives: { onnxLibs: [], interDir: 'inter', keyring: null },
    })
    expect(config.appId).toBe(APP_ID)
    expect(config.nsis.include).toMatch(/installer\.nsh$/)
  })

  it('the NSIS hooks stop the daemon and remove the login item', () => {
    const hooks = readFileSync(join(repo, 'apps', 'desktop', 'build', 'installer.nsh'), 'utf8')
    expect(hooks).toContain(`" ${STOP_DAEMON_FLAG}'`)
    expect(hooks).toContain(`DeleteRegValue HKCU "${RUN_KEY.replace(/^HKCU\\/, '')}" "${RUN_VALUE}"`)
  })
})
