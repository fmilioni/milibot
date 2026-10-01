// Portuguese on purpose: the patterns below spell the Portuguese letters and words they look for.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const LOCALES = /(^|\/)locales\//

const WORDS = [
  ...['nao', 'voce', 'usuario', 'arquivos', 'conhecimento', 'configuracoes', 'ensinar', 'desfazer', 'rotina'],
  ...['salvar', 'pronto', 'para', 'uma', 'todas', 'tudo', 'atual', 'geral', 'pessoal', 'equipe', 'resumo'],
  ...['feito', 'excluir', 'apagar', 'limpar', 'fechar', 'celular'],
]
const PORTUGUESE = new RegExp(
  [
    '[À-ÖØ-öø-ÿªº]',
    `\\b(${WORDS.join('|')})\\b`,
    // Also English words or identifiers (`todos` of todo_write, `.com`, `com1`): only as a spaced word.
    '(?<![^\\s@])(com|todos)(?!\\S)',
  ].join('|'),
  'i',
)
/** Accented words that are not Portuguese, used as loanwords and accent-folding samples. */
const NOT_PORTUGUESE =
  /(?<!\p{L})(caf[eé]s?|r[eé]sum[eé]|cr[eè]me|br[uû]l[eé]e|na[iï]ve|fa[cç]ade|łódź)(?!\p{L})/giu
// Spelled in parts so this file's own patterns are not taken for markers.
const PHRASE = ['Portuguese', 'on', 'purpose'].join(' ')
const MARKER = new RegExp(`${PHRASE}\\b(?!: <)`)
const MARKER_WITH_REASON = new RegExp(`${PHRASE}: \\S`)

function repoFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter((path) => path && !LOCALES.test(path) && existsSync(join(root, path)))
}

describe('Portuguese outside the locales', () => {
  it('appears only in files that say why', () => {
    const unmarked: string[] = []
    const reasonless: string[] = []
    const stale: string[] = []
    for (const path of repoFiles()) {
      const bytes = readFileSync(join(root, path))
      if (bytes.includes(0)) continue
      const lines = bytes.toString('utf8').split('\n')
      const hits = lines.flatMap((line, index) =>
        PORTUGUESE.test(line.replace(NOT_PORTUGUESE, ''))
          ? [`${path}:${index + 1} ${line.trim().slice(0, 100)}`]
          : [],
      )
      const markers = lines.filter((line) => MARKER.test(line))
      if (markers.some((line) => !MARKER_WITH_REASON.test(line))) reasonless.push(path)
      if (hits.length > 0 && markers.length === 0) unmarked.push(...hits)
      if (hits.length === 0 && markers.length > 0) stale.push(path)
    }
    expect(unmarked, `translate, or add "${PHRASE}: <why>"`).toEqual([])
    expect(reasonless, 'a marker must give its reason').toEqual([])
    expect(stale, 'markers in files without Portuguese').toEqual([])
  })
})
