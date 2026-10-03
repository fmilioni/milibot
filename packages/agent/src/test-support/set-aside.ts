import { newId } from '@milibot/shared'

import type { SetAsideEntry, SetAsideStore } from '../environment'

/** `SetAsideStore` in memory; `entries` keeps the dropped and woken ones with their status. */
export class InMemorySetAside implements SetAsideStore {
  entries: Array<SetAsideEntry & { status: 'waiting' | 'woken' | 'dropped' }> = []

  constructor(private readonly now: () => number) {}

  add(entry: { botId: string; conversationId: string; task: string; waitingOn: string[] }): SetAsideEntry {
    const row = {
      ...entry,
      id: newId('setAside'),
      createdAt: this.now(),
      alertedAt: null,
      status: 'waiting' as const,
    }
    this.entries.push(row)
    return this.view(row)
  }

  waiting(botId?: string): SetAsideEntry[] {
    return this.entries
      .filter((e) => e.status === 'waiting' && (!botId || e.botId === botId))
      .map((e) => this.view(e))
  }

  markWoken(id: string): void {
    for (const e of this.entries) if (e.id === id) e.status = 'woken'
  }

  markAlerted(ids: string[]): void {
    for (const e of this.entries) if (ids.includes(e.id)) e.alertedAt = this.now()
  }

  drop(botId: string, conversationId?: string): number {
    let dropped = 0
    for (const e of this.entries) {
      if (e.status !== 'waiting' || e.botId !== botId) continue
      if (conversationId && e.conversationId !== conversationId) continue
      e.status = 'dropped'
      dropped++
    }
    return dropped
  }

  private view({ status: _status, ...entry }: SetAsideEntry & { status: string }): SetAsideEntry {
    return { ...entry, waitingOn: [...entry.waitingOn] }
  }
}
