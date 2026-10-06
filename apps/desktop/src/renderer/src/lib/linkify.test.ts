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

  describe('ids and /workspace paths', () => {
    const ULID = '01m41qvydqnjxef4ax623he0my'
    const card = `bcd_${ULID}`
    const of = (value: string) =>
      tokenize(value).flatMap((t) => (t.type === 'link' ? [`${t.kind}:${t.text}`] : []))

    it('links every id kind the app opens', () => {
      for (const prefix of [
        'bcd',
        'brd',
        'dsg',
        'dfr',
        'plan',
        'wses',
        'kdoc',
        'prj',
        'skill',
        'rtn',
        'cnv',
        'bot',
      ])
        expect(of(`see ${prefix}_${ULID}.`)).toEqual([`ref:${prefix}_${ULID}`])
    })

    it('splits the text around an id', () => {
      expect(tokenize(`Card ${card}, done`)).toEqual([
        text('Card '),
        { type: 'link', kind: 'ref', text: card, href: card },
        text(', done'),
      ])
    })

    it('leaves tool names, slugs, other ids and malformed ids as text', () => {
      expect(of('plan_submit board_card_get bot-theo skill_load')).toEqual([])
      expect(of(`msg_${ULID} att_${ULID} ${card}x ${card.toUpperCase()} x${card}`)).toEqual([])
    })

    it('links /workspace file paths without the sentence punctuation', () => {
      expect(of('Saved to /workspace/milibot/design/NOTES.md.')).toEqual([
        'path:/workspace/milibot/design/NOTES.md',
      ])
      expect(of('(see /workspace/a/b.png), then')).toEqual(['path:/workspace/a/b.png'])
      expect(of('"/workspace/a.txt"')).toEqual(['path:/workspace/a.txt'])
    })

    it('leaves folders, dot segments and other roots as text', () => {
      expect(of('/workspace/milibot/ /workspace/../etc/passwd /home/agent/x.md /tmp/workspace/x')).toEqual([])
    })

    it('leaves an id in inline code as text, as markdown keeps code as code', () => {
      expect(of(`run \`${card}\` or \`see ${card} too\``)).toEqual([])
      expect(of(`\`${card}\` and ${card}`)).toEqual([`ref:${card}`])
      expect(of(`a \` before ${card}`)).toEqual([`ref:${card}`])
      expect(of('open `/workspace/x.md`')).toEqual(['path:/workspace/x.md'])
    })

    it('mixes URLs, ids and paths in order', () => {
      expect(of(`https://a.example.com/x ${card} /workspace/x.md`)).toEqual([
        'url:https://a.example.com/x',
        `ref:${card}`,
        'path:/workspace/x.md',
      ])
    })
  })
})
