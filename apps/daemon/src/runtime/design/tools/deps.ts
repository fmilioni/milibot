import type { Bot } from '@milibot/shared'

import type { DesignService } from '../service'

export interface DesignToolsDeps {
  designs: DesignService
  getBot: (id: string) => Bot | null
  cardConversation: (bot: Bot, conversationId: string | null) => string
}
