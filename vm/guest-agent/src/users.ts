import { readFileSync } from 'node:fs'

import { badRequest } from './errors.ts'

export interface PasswdEntry {
  name: string
  uid: number
  gid: number
  home: string
  shell: string
}

export function parsePasswd(content: string): PasswdEntry[] {
  return content
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(':'))
    .filter((f) => f.length >= 7)
    .map((f) => ({ name: f[0]!, uid: Number(f[2]), gid: Number(f[3]), home: f[5]!, shell: f[6]! }))
}

export function lookupUser(name: string, passwdFile = '/etc/passwd'): PasswdEntry | undefined {
  return parsePasswd(readFileSync(passwdFile, 'utf8')).find((u) => u.name === name)
}

export function requireUser(name: unknown): PasswdEntry {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(name))
    throw badRequest('invalid user', 'invalid_user')
  const entry = lookupUser(name)
  if (!entry) throw badRequest(`user not found: ${name}`, 'unknown_user')
  return entry
}

export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export interface RunAsOptions {
  user: PasswdEntry
  /** Shell command run through `bash -lc`. */
  cmd?: string
  /** Exact argv, still run through a login shell so /etc/profile.d is applied. */
  argv?: string[]
  env?: Record<string, string>
  display?: number
}

export interface SpawnSpec {
  file: string
  args: string[]
  env: Record<string, string>
}

// setpriv with --init-groups keeps supplementary groups (workspace, docker); Node's own uid/gid spawn drops them.
export function buildRunAs(opts: RunAsOptions): SpawnSpec {
  const { user } = opts
  let shellArgs: string[]
  if (opts.argv && opts.argv.length > 0) {
    shellArgs = ['-lc', 'exec "$0" "$@"', ...opts.argv]
  } else if (typeof opts.cmd === 'string' && opts.cmd.length > 0) {
    shellArgs = ['-lc', opts.cmd]
  } else {
    throw badRequest('cmd or argv is required', 'invalid_command')
  }
  const env: Record<string, string> = {
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    SHELL: '/bin/bash',
    PATH: DEFAULT_PATH,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
  }
  if (opts.display !== undefined) env.DISPLAY = `:${opts.display}`
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw badRequest(`invalid env name: ${k}`, 'invalid_env')
    if (typeof v !== 'string') throw badRequest(`env ${k} must be a string`, 'invalid_env')
    env[k] = v
  }
  if (user.uid === 0) return { file: '/bin/bash', args: shellArgs, env }
  return {
    file: '/usr/bin/setpriv',
    args: [`--reuid=${user.uid}`, `--regid=${user.gid}`, '--init-groups', '--', '/bin/bash', ...shellArgs],
    env,
  }
}
