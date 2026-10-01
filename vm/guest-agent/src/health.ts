import os from 'node:os'

import type { GuestHealth } from '@milibot/shared/portable/guest-api'

import { type BotInfo, displayRunning, listBots } from './bots.ts'
import { dataDiskMounted } from './paths.ts'

export interface HealthDeps {
  bots: () => BotInfo[]
  displayRunning: (display: number) => Promise<boolean>
  dataDiskMounted: () => boolean
}

const systemHealth: HealthDeps = { bots: listBots, displayRunning, dataDiskMounted }

/** `GET /health`: the daemon compares `agentSha` with its bundle and skips desktops already running. */
export async function health(agentSha: string | null, deps: HealthDeps = systemHealth): Promise<GuestHealth> {
  const displays = await Promise.all(
    deps.bots().map(async (b) => ({ ...b, running: await deps.displayRunning(b.display) })),
  )
  return {
    ok: true,
    agentSha,
    hostname: os.hostname(),
    node: process.version,
    dataDiskMounted: deps.dataDiskMounted(),
    displays,
  }
}
