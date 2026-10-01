import { describe, expect, it } from 'vitest'

import type { DaemonCommand } from '../../daemon/command'
import {
  appImageCommand,
  AUTOSTART_FILE,
  type AutostartDeps,
  autostartDir,
  autostartEnabled,
  autostartEntry,
  type AutostartFs,
  refreshAutostart,
  setAutostart,
} from './linux'

const packaged: DaemonCommand = {
  command: '/opt/Milibot/resources/node/bin/node',
  args: ['/opt/Milibot/resources/daemon/main.js'],
  env: {
    PATH: '/opt/Milibot/resources/node/bin:/usr/bin:/bin',
    MILIBOT_DATA_DIR: '/home/ana/.local/share/milibot',
  },
  cwd: '/opt/Milibot/resources/daemon',
}

/** In-memory filesystem: files and created folders. */
function memoryFs(): AutostartFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    exists: (path) => files.has(path),
    read: (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT ${path}`)
      return content
    },
    write: (path, content) => void files.set(path, content),
    mkdir: (path) => void dirs.add(path),
    remove: (path) => void files.delete(path),
  }
}

/** Parses the `Exec` value back into arguments, following the Desktop Entry spec. */
function parseExec(line: string): string[] {
  const unescaped = line.replace(/\\\\/g, '\\').replace(/%%/g, '%')
  const args: string[] = []
  let i = 0
  while (i < unescaped.length) {
    if (unescaped[i] === ' ') {
      i++
      continue
    }
    let arg = ''
    if (unescaped[i] === '"') {
      i++
      while (unescaped[i] !== '"') {
        if (unescaped[i] === '\\') i++
        arg += unescaped[i++]
      }
      i++
    } else {
      while (i < unescaped.length && unescaped[i] !== ' ') arg += unescaped[i++]
    }
    args.push(arg)
  }
  return args
}

const execOf = (entry: string) => parseExec(/^Exec=(.*)$/m.exec(entry)?.[1] ?? '')

describe('autostartDir', () => {
  it('follows XDG_CONFIG_HOME, falling back to ~/.config', () => {
    expect(autostartDir({ XDG_CONFIG_HOME: '/home/ana/cfg' }, '/home/ana')).toBe('/home/ana/cfg/autostart')
    expect(autostartDir({}, '/home/ana')).toBe('/home/ana/.config/autostart')
    expect(autostartDir({ XDG_CONFIG_HOME: '' }, '/home/ana')).toBe('/home/ana/.config/autostart')
    expect(autostartDir({ XDG_CONFIG_HOME: 'relative' }, '/home/ana')).toBe('/home/ana/.config/autostart')
  })
})

describe('autostartEntry', () => {
  it('runs the daemon command at login with its environment, folder and log', () => {
    const entry = autostartEntry(packaged, '/home/ana/.local/share/milibot/logs/daemon.log')
    expect(entry).toMatch(/^\[Desktop Entry\]\nType=Application\nName=Milibot\n/)
    expect(entry).toContain('NoDisplay=true')
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
    const [sh, flag, script] = execOf(entry)
    expect([sh, flag]).toEqual(['/bin/sh', '-c'])
    expect(script).toBe(
      "cd '/opt/Milibot/resources/daemon' && exec env MILIBOT_DATA_DIR='/home/ana/.local/share/milibot' " +
        "PATH='/opt/Milibot/resources/node/bin:/usr/bin:/bin' '/opt/Milibot/resources/node/bin/node' " +
        "'/opt/Milibot/resources/daemon/main.js' >> '/home/ana/.local/share/milibot/logs/daemon.log' 2>&1",
    )
  })

  it('an AppImage starts the AppImage file itself, never its transient mount', () => {
    const command = appImageCommand('/home/ana/Apps/Milibot 1.0.AppImage', '/home/ana/.local/share/milibot')
    const script = execOf(autostartEntry(command, '/home/ana/.local/share/milibot/logs/daemon.log'))[2]
    expect(script).toBe(
      "exec env MILIBOT_DATA_DIR='/home/ana/.local/share/milibot' '/home/ana/Apps/Milibot 1.0.AppImage' " +
        "'--start-daemon' >> '/home/ana/.local/share/milibot/logs/daemon.log' 2>&1",
    )
  })

  it('escapes quotes, dollars, backslashes and percent signs in paths', () => {
    const tricky: DaemonCommand = {
      command: `/home/an'a/$HOME/50%/node`,
      args: ['C:\\x', 'a"b`c'],
      env: {},
    }
    const script = execOf(autostartEntry(tricky, '/tmp/log'))[2]
    expect(script).toBe(`exec env '/home/an'\\''a/$HOME/50%/node' 'C:\\x' 'a"b\`c' >> '/tmp/log' 2>&1`)
  })
})

describe('setAutostart', () => {
  const setup = () => {
    const fs = memoryFs()
    const deps: AutostartDeps = {
      file: `/home/ana/.config/autostart/${AUTOSTART_FILE}`,
      logFile: '/home/ana/.local/share/milibot/logs/daemon.log',
      command: () => packaged,
      fs,
    }
    return { fs, deps }
  }

  it('writes the entry when turned on and removes it when turned off', () => {
    const { fs, deps } = setup()
    expect(autostartEnabled(deps)).toBe(false)
    expect(setAutostart(true, deps)).toBe(true)
    expect(fs.files.get(deps.file)).toBe(autostartEntry(packaged, deps.logFile))
    expect(fs.dirs).toEqual(new Set(['/home/ana/.config/autostart', '/home/ana/.local/share/milibot/logs']))
    expect(autostartEnabled(deps)).toBe(true)
    expect(setAutostart(false, deps)).toBe(false)
    expect(fs.files.size).toBe(0)
    expect(autostartEnabled(deps)).toBe(false)
  })

  it('rewrites an entry that points to an old copy of the app, and never creates one', () => {
    const { fs, deps } = setup()
    expect(refreshAutostart(deps)).toBe(false)
    expect(fs.files.size).toBe(0)
    setAutostart(true, deps)
    expect(refreshAutostart(deps)).toBe(false)
    deps.command = () => ({ ...packaged, command: '/home/ana/Apps/Milibot/node' })
    expect(refreshAutostart(deps)).toBe(true)
    expect(fs.files.get(deps.file)).toContain('/home/ana/Apps/Milibot/node')
  })
})
