import { CliError, usage } from '../../lib/args.ts'
import type { VmCliQmpResult } from '../../lib/shared.ts'
import { readConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { vmPaths } from '../paths.ts'
import { readPid } from '../qemu-process.ts'
import { qmp, qmpEndpoint } from '../qmp.ts'

const QMP_USAGE = 'qmp <wsDir> \'{"execute":"query-status"}\''

export async function cmdQmp(ctx: VmHostContext, wsDir: string, json: string): Promise<VmCliQmpResult> {
  const p = vmPaths(wsDir)
  const config = readConfig(p)
  if (!readPid(p)) throw new CliError('VM_NOT_RUNNING', 'VM is not running')
  let command: object
  try {
    command = JSON.parse(json) as object
  } catch {
    throw usage(QMP_USAGE)
  }
  const [res] = await qmp(qmpEndpoint(ctx.profile(), config), [command])
  return { ok: !res?.error, ...res }
}
