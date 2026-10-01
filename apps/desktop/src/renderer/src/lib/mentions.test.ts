import { describe, expect, it } from 'vitest'

import { activeMentionQuery, filterMentionTargets, insertMention, splitMentions } from './mentions'

const bots = [
  { id: 'b1', name: 'Analyst' },
  { id: 'b2', name: 'Iris' },
  { id: 'b3', name: 'Chief of Staff' },
  { id: 'b4', name: 'Chief' },
]

describe('splitMentions', () => {
  it('finds known mentions and leaves the rest as text', () => {
    expect(splitMentions('@Analyst closes and @Iris brings.', bots)).toEqual([
      { type: 'mention', text: '@Analyst', target: bots[0] },
      { type: 'text', text: ' closes and ' },
      { type: 'mention', text: '@Iris', target: bots[1] },
      { type: 'text', text: ' brings.' },
    ])
  })

  it('prefers the longest name and respects word boundaries', () => {
    const segments = splitMentions('hi @Chief of Staff and @Chief, and @Irisz', bots)
    expect(segments.filter((s) => s.type === 'mention').map((s) => s.text)).toEqual([
      '@Chief of Staff',
      '@Chief',
    ])
  })

  it('ignores e-mails and unknown names', () => {
    expect(splitMentions('talk to ana@Iris.com and @Nobody', bots)).toEqual([
      { type: 'text', text: 'talk to ana@Iris.com and @Nobody' },
    ])
  })

  it('matches case-insensitively and keeps the typed text', () => {
    const [first] = splitMentions('@analyst', bots)
    expect(first).toMatchObject({ type: 'mention', text: '@analyst', target: bots[0] })
  })
})

describe('mention autocomplete', () => {
  it('detects the query being typed before the caret', () => {
    expect(activeMentionQuery('So, who reviews this? @', 23)).toEqual({ start: 22, query: '' })
    expect(activeMentionQuery('hi @Ana', 7)).toEqual({ start: 3, query: 'Ana' })
    expect(activeMentionQuery('ana@x', 5)).toBeNull()
    expect(activeMentionQuery('@Ana\nx', 6)).toBeNull()
    expect(activeMentionQuery('no at sign', 10)).toBeNull()
  })

  it('ranks prefix matches first', () => {
    expect(filterMentionTargets(bots, 'i').map((b) => b.name)).toEqual(['Iris', 'Chief of Staff', 'Chief'])
    expect(filterMentionTargets(bots, '')).toHaveLength(4)
  })

  it('inserts the full name and moves the caret after it', () => {
    const text = 'hi @Ana all good'
    const query = activeMentionQuery(text, 7)!
    expect(insertMention(text, query, 'Analyst')).toEqual({ text: 'hi @Analyst all good', caret: 12 })
  })
})
