import { describe, expect, it } from 'vitest'

import { START_DAEMON_FLAG } from '../app-id'
import {
  parseRegQuery,
  quoteWindowsArg,
  refreshRunKey,
  regRunKey,
  RUN_KEY,
  RUN_VALUE,
  runCommand,
  type RunKey,
  type RunKeyDeps,
  runKeyEnabled,
  setRunKey,
} from './windows'

/** In-memory `Run` key that records every write. */
function memoryRunKey(): RunKey & { values: Map<string, string>; writes: number } {
  const values = new Map<string, string>()
  const key = {
    values,
    writes: 0,
    get: async (name: string) => values.get(name) ?? null,
    set: async (name: string, value: string) => {
      key.writes++
      values.set(name, value)
    },
    remove: async (name: string) => void values.delete(name),
  }
  return key
}

const EXE = 'C:\\Users\\ana\\AppData\\Local\\Programs\\Milibot\\Milibot.exe'

function deps(runKey: RunKey, overrides: Partial<RunKeyDeps> = {}): RunKeyDeps {
  return { runKey, executable: EXE, appPath: null, ...overrides }
}

describe('runCommand', () => {
  it('starts the packaged app with the daemon flag, the path quoted', () => {
    expect(runCommand({ executable: EXE, appPath: null })).toBe(`"${EXE}" ${START_DAEMON_FLAG}`)
  })

  it('passes the app folder first in dev', () => {
    expect(
      runCommand({ executable: 'C:\\dev\\electron.exe', appPath: 'C:\\dev\\My App\\apps\\desktop' }),
    ).toBe(`"C:\\dev\\electron.exe" "C:\\dev\\My App\\apps\\desktop" ${START_DAEMON_FLAG}`)
  })
})

describe('quoteWindowsArg', () => {
  it('quotes only when needed, escaping quotes and trailing backslashes', () => {
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('C:\\My Folder\\')).toBe('"C:\\My Folder\\\\"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  })
})

describe('Run key login item', () => {
  it('is off until turned on, and writes the command under the Milibot value', async () => {
    const key = memoryRunKey()
    expect(await runKeyEnabled(deps(key))).toBe(false)
    expect(await setRunKey(true, deps(key))).toBe(true)
    expect(key.values.get(RUN_VALUE)).toBe(`"${EXE}" ${START_DAEMON_FLAG}`)
    expect(await runKeyEnabled(deps(key))).toBe(true)
  })

  it('does not rewrite an unchanged value, and turning off removes it', async () => {
    const key = memoryRunKey()
    await setRunKey(true, deps(key))
    await setRunKey(true, deps(key))
    expect(key.writes).toBe(1)
    expect(await setRunKey(false, deps(key))).toBe(false)
    expect(key.values.has(RUN_VALUE)).toBe(false)
    expect(await setRunKey(false, deps(key))).toBe(false)
  })

  it('refresh points an installed value at this copy of the app, and never installs one', async () => {
    const key = memoryRunKey()
    expect(await refreshRunKey(deps(key))).toBe(false)
    expect(key.values.size).toBe(0)

    key.values.set(RUN_VALUE, '"D:\\Old\\Milibot.exe" --start-daemon')
    expect(await refreshRunKey(deps(key))).toBe(true)
    expect(key.values.get(RUN_VALUE)).toBe(`"${EXE}" ${START_DAEMON_FLAG}`)
    expect(await refreshRunKey(deps(key))).toBe(false)
  })

  it('leaves the other values of the key alone', async () => {
    const key = memoryRunKey()
    key.values.set('OneDrive', '"C:\\OneDrive.exe" /background')
    await setRunKey(true, deps(key))
    await setRunKey(false, deps(key))
    expect([...key.values.keys()]).toEqual(['OneDrive'])
  })
})

describe('regRunKey', () => {
  const QUERY = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    `    Milibot    REG_SZ    "${EXE}" --start-daemon`,
    '',
  ].join('\r\n')

  it('reads the value from reg query output', () => {
    expect(parseRegQuery(QUERY, 'Milibot')).toBe(`"${EXE}" --start-daemon`)
    expect(parseRegQuery(QUERY, 'Other')).toBeNull()
  })

  it('runs reg.exe with the Run key of the current user only', async () => {
    const calls: string[][] = []
    let exists = false
    const key = regRunKey(async (args) => {
      calls.push(args)
      if (args[0] === 'query') return exists ? { code: 0, stdout: QUERY } : { code: 1, stdout: '' }
      if (args[0] === 'add') exists = true
      if (args[0] === 'delete') exists = false
      return { code: 0, stdout: '' }
    })

    expect(await key.get(RUN_VALUE)).toBeNull()
    await key.remove(RUN_VALUE)
    expect(calls.some((args) => args[0] === 'delete')).toBe(false)

    await key.set(RUN_VALUE, `"${EXE}" --start-daemon`)
    expect(calls.at(-1)).toEqual([
      'add',
      RUN_KEY,
      '/v',
      'Milibot',
      '/t',
      'REG_SZ',
      '/d',
      `"${EXE}" --start-daemon`,
      '/f',
    ])
    expect(await key.get(RUN_VALUE)).toBe(`"${EXE}" --start-daemon`)
    await key.remove(RUN_VALUE)
    expect(calls.at(-1)).toEqual(['delete', RUN_KEY, '/v', 'Milibot', '/f'])
    expect(calls.every((args) => args[1] === RUN_KEY)).toBe(true)
    expect(RUN_KEY.startsWith('HKCU\\')).toBe(true)
  })

  it('reports a failed write', async () => {
    const key = regRunKey(async () => ({ code: 5, stdout: '' }))
    await expect(key.set(RUN_VALUE, 'x')).rejects.toThrow(/reg add failed \(5\)/)
  })
})
