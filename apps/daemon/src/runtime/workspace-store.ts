import type { Db } from '../db/sqlite'
import { BotStore } from './bots/store'
import { ConversationStore } from './conversations/store'
import { MessageStore } from './messages/store'
import { SettingsStore } from './settings/store'

/** The stores of the workspace's core aggregates over one database (one instance per runtime). */
export class WorkspaceStore {
  readonly settings: SettingsStore
  readonly bots: BotStore
  readonly conversations: ConversationStore
  readonly messages: MessageStore

  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.settings = new SettingsStore(db, now)
    this.bots = new BotStore(db, now)
    this.conversations = new ConversationStore(db, this.bots, now)
    this.messages = new MessageStore(db, this.conversations, now)
  }

  /** Soft-deletes a bot (never the last one); its direct chat and work sessions go with it. */
  deleteBot(id: string): { deletedConversationIds: string[] } {
    this.bots.assertDeletable(id)
    const at = this.now()
    return this.db.transaction(() => {
      this.bots.softDelete(id, at)
      return { deletedConversationIds: this.conversations.removeBot(id, at) }
    })()
  }
}
