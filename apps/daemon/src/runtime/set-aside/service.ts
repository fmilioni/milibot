import type { SetAsideEntry, SetAsideStore as SetAsidePort } from '@milibot/agent'
import type { setAsideEndpoints, SetAsideRequest, WorkspaceEvent } from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { SetAsideStore } from './store'

export interface SetAsideServiceDeps {
  db: Db
  emit: (event: WorkspaceEvent) => void
  now: () => number
}

const toEntry = ({ status: _s, wokenAt: _w, ...entry }: SetAsideRequest): SetAsideEntry => entry

/**
 * Requests bots set aside until their work in progress ends (`after_current_work`): the agent host keeps
 * them here, so they survive restarts, and the app lists and drops the ones still waiting.
 */
export class SetAsideService {
  private readonly store: SetAsideStore

  constructor(private readonly deps: SetAsideServiceDeps) {
    this.store = new SetAsideStore(deps.db, deps.now)
  }

  private changed(botIds: Iterable<string>): void {
    for (const botId of new Set(botIds)) this.deps.emit({ type: 'set_aside.changed', payload: { botId } })
  }

  /** What the agent host reads and writes. */
  port(): SetAsidePort {
    return {
      add: (entry) => {
        const request = this.store.add(entry)
        this.changed([request.botId])
        return toEntry(request)
      },
      waiting: (botId) => this.store.waiting(botId).map(toEntry),
      markAttempt: (id) => this.store.markAttempt(id),
      markActed: (id) => {
        const request = this.store.markActed(id)
        if (request) this.changed([request.botId])
      },
      markWoken: (id) => {
        const request = this.store.markWoken(id)
        if (request) this.changed([request.botId])
      },
      markAlerted: (ids) => this.store.markAlerted(ids),
      drop: (botId, filter = {}) => {
        const dropped = this.store.drop({ botId, ...filter })
        this.changed(dropped.map((r) => r.botId))
        return dropped.map(toEntry)
      },
    }
  }

  /** The conversation was deleted: nothing can wake the bot there anymore. */
  dropConversation(conversationId: string): void {
    const dropped = this.store.drop({ conversationId })
    this.changed(dropped.map((r) => r.botId))
  }

  handlers(): EndpointHandlers<keyof typeof setAsideEndpoints> {
    return {
      listSetAsideRequests: ({ query }) => this.store.waiting(query.botId),
      dropSetAsideRequest: ({ params }) => {
        const dropped = this.store.drop({ id: params.requestId })
        if (dropped.length === 0)
          throw new DaemonError('not_found', 'No request waiting with this id', {
            requestId: params.requestId,
          })
        this.changed(dropped.map((r) => r.botId))
        return { ok: true as const }
      },
    }
  }
}
