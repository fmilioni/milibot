import type { Bot } from '@milibot/shared'

import { laneInfo, type LaneKey } from '../host/lanes'

/** Suffix that tells a lane's process and MCP config apart from the chat lane's ('' for the chat lane). */
export function laneSuffix(key: LaneKey): string {
  const info = laneInfo(key)
  if (info.kind === 'main') return ''
  if (info.kind === 'internal') return `-${info.kind}`
  const short = info.sessionId?.slice(-8).toLowerCase() ?? 'chat'
  return info.kind === 'subagent' ? `-${short}-${key.split(':').at(-1)}` : `-${short}`
}

/** Label of a lane's process in the VM: `<procLabel>:<bot>[:<lane>]` (the daemon's orphan sweep matches it). */
export function laneProcLabel(procLabel: string, bot: Pick<Bot, 'slug'>, key: LaneKey): string {
  return `${procLabel}:${bot.slug}${laneSuffix(key).replace('-', ':')}`
}

/** Label of a one-shot process: `<procLabel>-<purpose>:<bot>`. */
export function oneShotProcLabel(procLabel: string, bot: Pick<Bot, 'slug'>, purpose = 'summary'): string {
  return `${procLabel}-${purpose}:${bot.slug}`
}
