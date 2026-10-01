import { CliError, usage } from '../../lib/args.ts'
import type { VmCliSnapshotResult } from '../../lib/shared.ts'
import { readConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { vmPaths } from '../paths.ts'
import { qemuImg, snapshotsOf } from '../qemu-img.ts'
import { readPid, requireStopped } from '../qemu-process.ts'

const SNAPSHOT_NAME = /^[A-Za-z0-9._-]{1,64}$/
const FLAG = { create: '-c', restore: '-a', delete: '-d' } as const

export const SNAPSHOT_USAGE = 'snapshot create|list|restore|delete <wsDir> [name]'

export async function cmdSnapshot(
  ctx: VmHostContext,
  action: string,
  wsDir: string,
  name: string | undefined,
): Promise<VmCliSnapshotResult> {
  const p = vmPaths(wsDir)
  const config = readConfig(p)
  if (action === 'list') {
    return {
      ok: true,
      snapshots: await snapshotsOf(ctx, p.system, readPid(p) ? { config, drive: 'sys' } : null),
    }
  }
  if (action !== 'create' && action !== 'restore' && action !== 'delete') throw usage(SNAPSHOT_USAGE)
  if (!name || !SNAPSHOT_NAME.test(name)) throw usage('snapshot name must match [A-Za-z0-9._-]{1,64}')
  requireStopped(p)
  const has = (await snapshotsOf(ctx, p.system)).some((s) => s.name === name)
  if (action === 'create' && has) throw new CliError('SNAPSHOT_EXISTS', `snapshot ${name} already exists`)
  if (action !== 'create' && !has) throw new CliError('SNAPSHOT_NOT_FOUND', `snapshot ${name} not found`)
  await qemuImg(ctx, 'snapshot', FLAG[action], name, p.system)
  return { ok: true, action, name, snapshots: await snapshotsOf(ctx, p.system) }
}
