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
      attempts: 0,
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

  markAttempt(id: string): void {
    for (const e of this.entries) if (e.id === id) e.attempts++
  }

  markWoken(id: string): void {
    for (const e of this.entries) if (e.id === id) e.status = 'woken'
  }

  markAlerted(ids: string[]): void {
    for (const e of this.entries) if (ids.includes(e.id)) e.alertedAt = this.now()
  }

  drop(botId: string, filter: { conversationId?: string; id?: string } = {}): SetAsideEntry[] {
    const dropped: SetAsideEntry[] = []
    for (const e of this.entries) {
      if (e.status !== 'waiting' || e.botId !== botId) continue
      if (filter.conversationId && e.conversationId !== filter.conversationId) continue
      if (filter.id && e.id !== filter.id) continue
      e.status = 'dropped'
      dropped.push(this.view(e))
    }
    return dropped
  }

  private view({ status: _status, ...entry }: SetAsideEntry & { status: string }): SetAsideEntry {
    return { ...entry, waitingOn: [...entry.waitingOn] }
  }
}
