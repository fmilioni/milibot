// Workspace VM lifecycle. Every command prints one JSON object on stdout; failures print
// {"ok":false,"error":{"code","message"}} and exit 1 (usage errors exit 2).
import fs from 'node:fs'
import path from 'node:path'

import { CliError, type Flags, parseArgs, usage } from '../lib/args.ts'
import { isEntryPoint } from '../lib/entry.ts'
import { searchPath, type VmCliErrorBody } from '../lib/shared.ts'
import { cmdCreate } from '../workspace/commands/create.ts'
import { cmdGrowDisk, GROW_DISK_USAGE } from '../workspace/commands/grow-disk.ts'
import { cmdQmp } from '../workspace/commands/qmp.ts'
import { cmdResetSystem } from '../workspace/commands/reset-system.ts'
import { cmdResize } from '../workspace/commands/resize.ts'
import { cmdSnapshot, SNAPSHOT_USAGE } from '../workspace/commands/snapshot.ts'
import { cmdStart } from '../workspace/commands/start.ts'
import { cmdStatus } from '../workspace/commands/status.ts'
import { cmdStop } from '../workspace/commands/stop.ts'
import { type VmHostContext, vmHostContext } from '../workspace/context.ts'
import { vmPaths } from '../workspace/paths.ts'

export const HELP = `usage: node vm/host/src/cli/workspace-vm.ts <command> ...  (or vm/workspace-vm.sh)
  create <wsDir> --port-base P [--name N] [--cpus 4] [--mem-gb 8] [--data-gb 60] [--system-gb 40] [--golden FILE]
  start <wsDir> [--wait] [--timeout-sec 180] [--whpx-kernel-irqchip on|off]
  stop <wsDir> [--timeout-sec 60] [--force]
  status <wsDir>
  reset-system <wsDir> [--golden FILE]
  ${SNAPSHOT_USAGE}
  resize <wsDir> [--cpus N] [--mem-gb N] [--port-base P (VM stopped)]
  ${GROW_DISK_USAGE}
  qmp <wsDir> '<json command>'`

async function dispatch(ctx: VmHostContext, command: string, rest: string[], flags: Flags): Promise<object> {
  const need = (n: number, message: string) => {
    if (rest.length < n) throw usage(message)
  }
  const [a = '', b = '', c = ''] = rest
  switch (command) {
    case 'create':
      need(1, 'create <wsDir> --port-base P')
      return cmdCreate(ctx, a, flags)
    case 'start':
      need(1, 'start <wsDir>')
      return cmdStart(ctx, a, flags)
    case 'stop':
      need(1, 'stop <wsDir>')
      return cmdStop(ctx, a, flags)
    case 'status':
      need(1, 'status <wsDir>')
      return cmdStatus(ctx, a)
    case 'reset-system':
      need(1, 'reset-system <wsDir>')
      return cmdResetSystem(ctx, a, flags)
    case 'snapshot':
      need(2, SNAPSHOT_USAGE)
      return cmdSnapshot(ctx, a, b, rest[2])
    case 'resize':
      need(1, 'resize <wsDir> [--cpus N] [--mem-gb N] [--port-base P]')
      return cmdResize(ctx, a, flags)
    case 'grow-disk':
      need(3, GROW_DISK_USAGE)
      return cmdGrowDisk(ctx, a, b, c)
    case 'qmp':
      need(2, "qmp <wsDir> '<json>'")
      return cmdQmp(ctx, a, b)
    default:
      throw usage(`unknown command: ${command}\n${HELP}`)
  }
}

/** Runs one command; returns the exit code after printing its JSON. */
export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [command, ...rest] = positional
  if (command === undefined || command === 'help' || flags.help) {
    process.stderr.write(HELP + '\n')
    return command === undefined && !flags.help ? 2 : 0
  }
  try {
    const wsIndex = command === 'snapshot' ? 1 : 0
    const wsDir = rest[wsIndex]
    if (wsDir !== undefined) {
      rest[wsIndex] = path.resolve(wsDir)
      // QMP's unix socket is addressed relative to the VM dir (see qmpEndpoint).
      const vmDir = vmPaths(wsDir).vm
      if (fs.existsSync(vmDir)) process.chdir(vmDir)
    }
    const result = await dispatch(vmHostContext(), command, rest, flags)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return 0
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError('INTERNAL', (err as Error)?.message ?? String(err))
    const body: VmCliErrorBody = { ok: false, error: { code: e.code, message: e.message } }
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
    return e.exitCode
  }
}

if (isEntryPoint(import.meta.url)) {
  // GUI apps and login items start with a minimal PATH; QEMU lives in Homebrew, /usr/bin or Program Files\qemu.
  process.env.PATH = searchPath({ platform: process.platform, env: process.env })
  process.exitCode = await main(process.argv.slice(2))
}
