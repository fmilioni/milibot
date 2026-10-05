import { describe, expect, it } from 'vitest'

import { tokenize } from './linkify'

const link = (url: string) => ({ type: 'link', kind: 'url', text: url, href: url })
const text = (value: string) => ({ type: 'text', text: value })
const links = (value: string) =>
  tokenize(value)
    .filter((t) => t.type === 'link')
    .map((t) => t.text)

describe('tokenize', () => {
  it('finds a URL in the middle of the text', () => {
    expect(tokenize('Approve https://github.com/org/repo/pull/18 to merge')).toEqual([
      text('Approve '),
      link('https://github.com/org/repo/pull/18'),
      text(' to merge'),
    ])
  })

  it('finds several URLs, at the edges too', () => {
    expect(tokenize('http://a.example.com and https://b.example.com/x?q=1#top')).toEqual([
      link('http://a.example.com'),
      text(' and '),
      link('https://b.example.com/x?q=1#top'),
    ])
  })

  it('leaves trailing punctuation and quotes out of the link', () => {
    expect(links('See https://a.example.com/x.')).toEqual(['https://a.example.com/x'])
    expect(links('https://a.example.com/x, https://b.example.com/y;')).toEqual([
      'https://a.example.com/x',
      'https://b.example.com/y',
    ])
    expect(links('Is it https://a.example.com/x?!')).toEqual(['https://a.example.com/x'])
    expect(links("'https://a.example.com/x'")).toEqual(['https://a.example.com/x'])
    expect(links('«https://a.example.com/x»')).toEqual(['https://a.example.com/x'])
    expect(links('"https://a.example.com/x".')).toEqual(['https://a.example.com/x'])
  })

  it('keeps a closing parenthesis only when it closes one of the URL', () => {
    expect(links('(see https://a.example.com/x)')).toEqual(['https://a.example.com/x'])
    expect(links('the page (https://en.wikipedia.org/wiki/Rust_(language)).')).toEqual([
      'https://en.wikipedia.org/wiki/Rust_(language)',
    ])
  })

  it('returns plain text when there is no URL', () => {
    expect(tokenize('Nothing to link here.')).toEqual([text('Nothing to link here.')])
    expect(tokenize('')).toEqual([text('')])
    expect(tokenize('a bare https:// is not a link')).toEqual([text('a bare https:// is not a link')])
  })

  it('ignores other schemes and URLs glued to a word', () => {
    expect(links('ftp://files.example.com javascript:alert(1) mailto:a@b.com')).toEqual([])
    expect(links('xhttps://a.example.com')).toEqual([])
  })

  it('keeps line breaks around the links', () => {
    expect(tokenize('one\nhttps://a.example.com\ntwo')).toEqual([
      text('one\n'),
      link('https://a.example.com'),
      text('\ntwo'),
    ])
  })
})
