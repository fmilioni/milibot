import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DaemonCommand } from '../../daemon/command'
import {
  LAUNCH_AGENT_LABEL,
  launchAgentPlist,
  type LoginItemDeps,
  loginItemStatus,
  refreshLoginItem,
  setLoginItem,
} from './mac'

const packaged: DaemonCommand = {
  command: '/Applications/Milibot.app/Contents/Resources/node/bin/node',
  args: ['/Applications/Milibot.app/Contents/Resources/daemon/main.js'],
  env: {
    PATH: '/Applications/Milibot.app/Contents/Resources/node/bin:/opt/homebrew/bin:/usr/bin:/bin',
    MILIBOT_DATA_DIR: '/Users/ana/Library/Application Support/Milibot',
  },
  cwd: '/Applications/Milibot.app/Contents/Resources/daemon',
}

describe('launchAgentPlist', () => {
  it('runs the daemon command once at login, logging to the data root', () => {
    const plist = launchAgentPlist(packaged, '/Users/ana/Library/Application Support/Milibot/logs/daemon.log')
    expect(plist).toContain(`<key>Label</key>\n\t<string>${LAUNCH_AGENT_LABEL}</string>`)
    expect(plist).toContain(
      '<array>\n\t\t<string>/Applications/Milibot.app/Contents/Resources/node/bin/node</string>\n\t\t<string>/Applications/Milibot.app/Contents/Resources/daemon/main.js</string>\n\t</array>',
    )
    expect(plist).toContain(
      '<key>WorkingDirectory</key>\n\t<string>/Applications/Milibot.app/Contents/Resources/daemon</string>',
    )
    expect(plist).toContain(
      '<key>MILIBOT_DATA_DIR</key>\n\t\t<string>/Users/ana/Library/Application Support/Milibot</string>',
    )
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>')
    expect(plist).toContain('<key>KeepAlive</key>\n\t<false/>')
    expect(plist).toContain(
      '<key>StandardErrorPath</key>\n\t<string>/Users/ana/Library/Application Support/Milibot/logs/daemon.log</string>',
    )
  })

  it('escapes XML in paths and arguments', () => {
    const plist = launchAgentPlist(
      { command: '/Users/a&b/node', args: ['--import', 'file:///x/<y>.mjs'], env: {} },
      '/tmp/log',
    )
    expect(plist).toContain('<string>/Users/a&amp;b/node</string>')
    expect(plist).toContain('<string>file:///x/&lt;y&gt;.mjs</string>')
    expect(plist).not.toContain('WorkingDirectory')
  })
})

describe('setLoginItem', () => {
  let dir: string
  let calls: string[][]
  let job: { loaded: boolean; pid: number | null }
  let deps: LoginItemDeps

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'milibot-login-item-'))
    calls = []
    job = { loaded: false, pid: null }
    deps = {
      plistPath: join(dir, 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
      domain: 'gui/501',
      logFile: join(dir, 'data', 'logs', 'daemon.log'),
      command: () => packaged,
      launchctl: async (args) => {
        calls.push(args)
        if (args[0] === 'print')
          return job.loaded
            ? {
                code: 0,
                stdout: `gui/501/${LAUNCH_AGENT_LABEL} = {\n\tstate = ${job.pid ? `running\n\tpid = ${job.pid}` : 'not running'}\n}`,
              }
            : { code: 113, stdout: '' }
        if (args[0] === 'bootstrap') job.loaded = true
        if (args[0] === 'bootout') job.loaded = false
        return { code: 0, stdout: '' }
      },
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('installs and loads the LaunchAgent', async () => {
    expect(await setLoginItem(true, deps)).toBe(true)
    expect(readFileSync(deps.plistPath, 'utf8')).toBe(launchAgentPlist(packaged, deps.logFile))
    expect(existsSync(join(dir, 'data', 'logs'))).toBe(true)
    expect(calls.at(-1)).toEqual(['bootstrap', 'gui/501', deps.plistPath])
    expect(await loginItemStatus(deps)).toEqual({ enabled: true, loaded: true, pid: null })
  })

  it('does not load a job launchd already has', async () => {
    job = { loaded: true, pid: 4242 }
    await setLoginItem(true, deps)
    expect(calls.map((c) => c[0])).toEqual(['print'])
    expect(existsSync(deps.plistPath)).toBe(true)
  })

  it('turning off removes the plist and unloads an idle job', async () => {
    await setLoginItem(true, deps)
    expect(await setLoginItem(false, deps)).toBe(false)
    expect(existsSync(deps.plistPath)).toBe(false)
    expect(calls.at(-1)).toEqual(['bootout', `gui/501/${LAUNCH_AGENT_LABEL}`])
  })

  it('turning off never stops the running daemon', async () => {
    await setLoginItem(true, deps)
    job.pid = 777
    calls = []
    await setLoginItem(false, deps)
    expect(existsSync(deps.plistPath)).toBe(false)
    expect(calls.map((c) => c[0])).toEqual(['print'])
  })

  it('reports and rewrites a plist that points to an old copy of the app', async () => {
    expect(refreshLoginItem(deps)).toBe(false)
    await setLoginItem(true, deps)
    expect(refreshLoginItem(deps)).toBe(false)
    deps.command = () => ({ ...packaged, command: '/Users/ana/Applications/Milibot.app/node' })
    expect(refreshLoginItem(deps)).toBe(true)
    expect(readFileSync(deps.plistPath, 'utf8')).toContain('/Users/ana/Applications/Milibot.app/node')
  })

  it('fails loudly when launchd refuses the job', async () => {
    deps.launchctl = async (args) => ({ code: args[0] === 'print' ? 113 : 5, stdout: '' })
    await expect(setLoginItem(true, deps)).rejects.toThrow(/bootstrap failed/)
  })
})
