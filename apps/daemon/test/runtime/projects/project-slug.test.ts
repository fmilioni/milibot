import { describe, expect, it } from 'vitest'

import { projectSlug } from '../../../src/runtime/projects/service'

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

// Stored project slugs: these outputs must never change.
describe('projectSlug pinned outputs', () => {
  it('keeps the slugs projects were stored with', () => {
    expect(CORPUS.map(projectSlug)).toEqual([
      'loja-nova',
      'acao-rapida-relatorio-c',
      'sao-joao-festa',
      '9-lives-of-cats',
      'hello-world',
      'project',
      'project',
      'le',
      'unicode-stra-e-istanbul',
      'aaaaaaaaaaaaaaaaaaaaaaa-bcd',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'lorem-ipsum-dolor-sit-amet-consectetur-a',
    ])
  })
})
