import { describe, expect, it } from 'vitest'

import { Avatar, randomAvatar } from './avatar'
import { BotScope, findBotByRef } from './bots'

// Portuguese on purpose: an accented pt name checks folded bot references.

describe('findBotByRef', () => {
  const bots = [
    { id: 'bot_1', slug: 'joao', name: 'João Silva' },
    { id: 'bot_2', slug: 'dex', name: 'Dex' },
  ]

  it('matches id, slug or folded name, with an optional @', () => {
    expect(findBotByRef(bots, 'bot_2')?.slug).toBe('dex')
    expect(findBotByRef(bots, '@Dex')?.id).toBe('bot_2')
    expect(findBotByRef(bots, ' joão silva ')?.id).toBe('bot_1')
    expect(findBotByRef(bots, 'joao')?.id).toBe('bot_1')
  })

  it('falls back to a name prefix of 3+ characters', () => {
    expect(findBotByRef(bots, 'Joã')?.id).toBe('bot_1')
    expect(findBotByRef(bots, 'Jo')).toBeNull()
    expect(findBotByRef(bots, 'nobody')).toBeNull()
  })
})

describe('bot schemas', () => {
  it('caps bot scopes at 500 ids', () => {
    expect(BotScope.safeParse('all').success).toBe(true)
    expect(BotScope.safeParse(Array.from({ length: 501 }, (_, i) => `bot_${i}`)).success).toBe(false)
  })

  it('produces valid random avatars', () => {
    let seed = 0
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    for (let i = 0; i < 50; i++) expect(Avatar.safeParse(randomAvatar(random)).success).toBe(true)
  })
})
