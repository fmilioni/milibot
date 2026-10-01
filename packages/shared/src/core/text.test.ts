import { describe, expect, it } from 'vitest'

import { clipLine, estimateTokens, foldText, slugify } from './text'

// Portuguese on purpose: accent folding and slugs of pt-BR names.
const CORPUS = [
  'Loja Nova!',
  'Ação Rápida — Relatório Ç',
  'São João 🎉 Festa',
  '9 lives of cats',
  '  --Hello__World--  ',
  '',
  '!!!',
  'ﬁle ² ｆｕｌｌ ½',
  'Ünïcödé Straße İstanbul',
  'a'.repeat(23) + ' bcd',
  'a'.repeat(39) + ' bcd',
  'a'.repeat(47) + ' bcd',
  'a'.repeat(59) + ' bcd',
  'a'.repeat(63) + ' bcd',
  '1' + 'b'.repeat(30),
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.',
]

// Stored identifiers depend on these exact outputs: never change them.
describe('slugify pinned outputs', () => {
  const cases: Array<[string, (text: string) => string, string[]]> = [
    [
      'bot slug (workspace-store, 24 chars, starts with a letter)',
      (name) => {
        const base = slugify(name, { maxLength: 24 })
        if (!base) return 'bot'
        return /^[a-z]/.test(base) ? base : slugify(`b-${base}`, { maxLength: 24 })
      },
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        'b-9-lives-of-cats',
        'hello-world',
        'bot',
        'bot',
        'le',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'b-1bbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-am',
      ],
    ],
    [
      'attachment folder (attachment-paths, 48 chars, NFKD)',
      (text) => slugify(text, { maxLength: 48, normalize: 'NFKD' }),
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        '9-lives-of-cats',
        'hello-world',
        '',
        '',
        'file-2-full-1-2',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-amet-consectetur-adipiscin',
      ],
    ],
    [
      'branch part (tools slugPart, raw cut at 40)',
      (value) => slugify(value).slice(0, 40) || 'work',
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        '9-lives-of-cats',
        'hello-world',
        'work',
        'work',
        'le',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-amet-consectetur-a',
      ],
    ],
    [
      'SSH key comment (credentials)',
      (name) => slugify(name, { fallback: 'workspace' }),
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        '9-lives-of-cats',
        'hello-world',
        'workspace',
        'workspace',
        'le',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-amet-consectetur-adipiscing-elit-sed-do-eiusmod-tempor-incididunt-ut-labore-et-dolore-magna-aliqua-ut-enim-ad-minim-veniam-quis-nostrud-exercitation-ullamco-laboris-nisi-ut-aliquip',
      ],
    ],
    [
      'skill name (skills/format)',
      (text) => slugify(text, { maxLength: 64, fallback: 'skill' }),
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        '9-lives-of-cats',
        'hello-world',
        'skill',
        'skill',
        'le',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-amet-consectetur-adipiscing-elit-sed-do-ei',
      ],
    ],
    [
      'design export name (design/service, raw cut at 60)',
      (value) => slugify(value).slice(0, 60) || 'frame',
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        '9-lives-of-cats',
        'hello-world',
        'frame',
        'frame',
        'le',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-amet-consectetur-adipiscing-elit-sed-d',
      ],
    ],
    [
      'backup file name (BackupSection)',
      (name) => slugify(name, { fallback: 'workspace' }),
      [
        'loja-nova',
        'acao-rapida-relatorio-c',
        'sao-joao-festa',
        '9-lives-of-cats',
        'hello-world',
        'workspace',
        'workspace',
        'le',
        'unicode-stra-e-istanbul',
        'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bcd',
        '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'lorem-ipsum-dolor-sit-amet-consectetur-adipiscing-elit-sed-do-eiusmod-tempor-incididunt-ut-labore-et-dolore-magna-aliqua-ut-enim-ad-minim-veniam-quis-nostrud-exercitation-ullamco-laboris-nisi-ut-aliquip',
      ],
    ],
  ]
  it.each(cases)('%s', (_, slug, expected) => {
    expect(CORPUS.map(slug)).toEqual(expected)
  })
})

describe('foldText', () => {
  it('drops accents and case, trimming only when asked', () => {
    expect(foldText(' Ação Rápida ')).toBe(' acao rapida ')
    expect(foldText(' Ação Rápida ', { trim: true })).toBe('acao rapida')
  })

  it('folds compatibility characters with NFKD', () => {
    expect(foldText('ﬁle ²')).toBe('ﬁle ²')
    expect(foldText('ﬁle ²', { normalize: 'NFKD' })).toBe('file 2')
  })
})

describe('clipLine', () => {
  const long = 'one  two\nthree four'

  it('flattens whitespace and keeps the ellipsis within max by default', () => {
    expect(clipLine(long, 100)).toBe('one two three four')
    expect(clipLine(long, 8)).toBe('one two…')
    expect(clipLine(long, 8)).toHaveLength(8)
  })

  it('can only trim, or keep the text as is', () => {
    expect(clipLine(`  ${long}  `, 100, { whitespace: 'trim' })).toBe(long)
    expect(clipLine(`  ${long}`, 6, { whitespace: 'keep' })).toBe('  one…')
  })

  it('can keep max characters and add the ellipsis after them', () => {
    expect(clipLine('abcdef', 3, { whitespace: 'keep', withinMax: false })).toBe('abc…')
    expect(clipLine('abc', 3, { withinMax: false })).toBe('abc')
  })
})

describe('small helpers', () => {
  it('estimates tokens as chars / 3.5', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcdefg')).toBe(2)
    expect(estimateTokens('abcdefgh')).toBe(3)
  })
})
