import { type BotStatus, isBusyStatus, type WorkspaceEvent } from '@milibot/shared'

interface PendingSync {
  token: number
  /** Bots an event reported while the snapshot was out: the event is newer, so it wins. */
  touched: Set<string>
}

/**
 * The status of every bot of every workspace whose runtime is running, from `bot.status` events and
 * `listBots` snapshots. A workspace the app can no longer follow is forgotten (`clear`) instead of
 * keeping statuses nobody will update.
 */
export class BusyBots {
  private readonly statuses = new Map<string, Map<string, BotStatus>>()
  private readonly syncs = new Map<string, PendingSync>()
  private nextToken = 1

  /** Busy bots across every workspace. */
  get count(): number {
    let busy = 0
    for (const bots of this.statuses.values())
      for (const status of bots.values()) if (isBusyStatus(status)) busy++
    return busy
  }

  apply(workspaceId: string, event: WorkspaceEvent): void {
    if (event.type === 'bot.status') this.set(workspaceId, event.payload.botId, event.payload.status)
    else if (event.type === 'bot.deleted') this.set(workspaceId, event.payload.botId, null)
  }

  clear(workspaceId: string): void {
    this.statuses.delete(workspaceId)
    this.syncs.delete(workspaceId)
  }

  /** A snapshot is about to be requested; pass the token to `finishSync` with its answer. */
  beginSync(workspaceId: string): number {
    const token = this.nextToken++
    this.syncs.set(workspaceId, { token, touched: new Set() })
    return token
  }

  isPending(workspaceId: string, token: number): boolean {
    return this.syncs.get(workspaceId)?.token === token
  }

  /** Ignored when the workspace was cleared or a newer snapshot began meanwhile. */
  finishSync(
    workspaceId: string,
    token: number,
    bots: ReadonlyArray<{ id: string; status: BotStatus }>,
  ): void {
    const pending = this.syncs.get(workspaceId)
    if (pending?.token !== token) return
    this.syncs.delete(workspaceId)
    const current = this.statuses.get(workspaceId)
    const next = new Map<string, BotStatus>()
    for (const bot of bots) if (!pending.touched.has(bot.id)) next.set(bot.id, bot.status)
    for (const botId of pending.touched) {
      const status = current?.get(botId)
      if (status) next.set(botId, status)
    }
    this.statuses.set(workspaceId, next)
  }

  private set(workspaceId: string, botId: string, status: BotStatus | null): void {
    this.syncs.get(workspaceId)?.touched.add(botId)
    let bots = this.statuses.get(workspaceId)
    if (!bots) {
      bots = new Map()
      this.statuses.set(workspaceId, bots)
    }
    if (status) bots.set(botId, status)
    else bots.delete(botId)
  }
}
