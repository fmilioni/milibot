import { describe, expect, it } from 'vitest'

import { parseMentions } from './groups'

// Portuguese on purpose: 'Íris' checks accent-insensitive mentions and @todos is the pt alias of @all.

const ana = { id: 'bot_ana', name: 'Ana', slug: 'ana' }
const iris = { id: 'bot_iris', name: 'Íris', slug: 'iris' }
const lia = { id: 'bot_lia', name: 'Lia Souza', slug: 'lia' }

describe('parseMentions', () => {
  it('parses @names (accents, spaces, slugs) and @todos into bot ids', () => {
    const bots = [ana, iris, lia]
    expect(parseMentions('@Ana and @iris, take a look', bots)).toEqual([ana.id, iris.id])
    expect(parseMentions('hey @Lia Souza!', bots)).toEqual([lia.id])
    expect(parseMentions('email ana@x.com and @Anabel', bots)).toEqual([])
    expect(parseMentions('@todos good morning', bots)).toEqual([ana.id, iris.id, lia.id])
  })

  it('prefers the longest name and needs a word boundary after it', () => {
    const bots = [ana, { id: 'bot_anabel', name: 'Anabel', slug: 'anabel' }]
    expect(parseMentions('@Anabel hi', bots)).toEqual(['bot_anabel'])
    expect(parseMentions('@Anacleto hi', bots)).toEqual([])
    expect(parseMentions('no mention here', bots)).toEqual([])
  })
})
