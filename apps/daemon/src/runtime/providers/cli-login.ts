import type { GuestClient } from '../vm'

/** How an engine's login runs in a terminal on a bot's desktop. */
export interface CliLogin {
  /** Window title. */
  title: string
  /** What the terminal runs (bash -lc) as `agent`. */
  command: string
  /** Label of the terminal's process: `login:<name>:<display>`. */
  name: string
}

function loginTerminalLabel(login: Pick<CliLogin, 'name'>, displayNum: number): string {
  return `login:${login.name}:${displayNum}`
}

export async function loginTerminalOpen(
  guest: Pick<GuestClient, 'listProcs'>,
  login: Pick<CliLogin, 'name'>,
  displayNum: number,
): Promise<boolean> {
  const label = loginTerminalLabel(login, displayNum)
  const { procs } = await guest.listProcs()
  return procs.some((p) => p.label === label && p.running)
}

/** A terminal running the engine's login as `agent` on a bot's desktop; none is added while one is open there. */
export async function openLoginTerminal(
  guest: Pick<GuestClient, 'listProcs' | 'startProc'>,
  login: CliLogin,
  displayNum: number,
): Promise<'opened' | 'already_open'> {
  if (await loginTerminalOpen(guest, login, displayNum)) return 'already_open'
  await guest.startProc({
    user: 'agent',
    argv: [
      'xfce4-terminal',
      '--disable-server',
      `--title=${login.title}`,
      '--working-directory=/workspace',
      '--geometry=110x32',
      '-x',
      'bash',
      '-lc',
      login.command,
    ],
    cwd: '/workspace',
    display: displayNum,
    label: loginTerminalLabel(login, displayNum),
  })
  return 'opened'
}
