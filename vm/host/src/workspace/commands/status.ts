import fs from 'node:fs'

import type { VmCliStatus } from '../../lib/shared.ts'
import { readConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { currentGolden } from '../golden.ts'
import { vmPaths } from '../paths.ts'
import { agentPing, portsOf } from '../ports.ts'
import { diskInfo } from '../qemu-img.ts'
import { readPid } from '../qemu-process.ts'
import { qmp, qmpEndpoint } from '../qmp.ts'

export async function cmdStatus(ctx: VmHostContext, wsDir: string): Promise<VmCliStatus> {
  const p = vmPaths(wsDir)
  const config = readConfig(p)
  const pid = readPid(p)
  const prof = ctx.profile()
  let qmpStatus: string | null = null
  if (pid) {
    try {
      const [res] = await qmp(qmpEndpoint(prof, config), [{ execute: 'query-status' }])
      qmpStatus = (res?.return as { status?: string } | undefined)?.status ?? null
    } catch {
      qmpStatus = 'unreachable'
    }
  }
  const live = (drive: string) => (pid ? { config, drive } : null)
  return {
    ok: true,
    name: config.name,
    state: pid ? 'running' : 'stopped',
    pid,
    qmpStatus,
    agentReachable: pid ? await agentPing(config.portBase) : false,
    agentUrl: `http://127.0.0.1:${config.portBase}`,
    tokenFile: p.token,
    ports: portsOf(config),
    cpus: config.cpus,
    memGb: config.memGb,
    golden: { path: config.golden, version: config.goldenVersion, exists: fs.existsSync(config.golden) },
    currentGolden: currentGolden(ctx),
    running: pid && config.running?.pid === pid ? config.running : null,
    accel: { kind: prof.accelKind, slow: prof.slow, reason: prof.slowReason },
    disks: {
      system: await diskInfo(ctx, p.system, live('sys')),
      data: await diskInfo(ctx, p.data, live('data')),
    },
    vmDir: p.vm,
  }
}
