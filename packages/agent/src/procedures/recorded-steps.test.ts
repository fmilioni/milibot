import type { RecordedStep } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { recordedStepText } from './recorded-steps'

const STEPS: RecordedStep[] = [
  { kind: 'click', at: 0, x: 1, y: 2 },
  { kind: 'click', at: 0 },
  { kind: 'double_click', at: 0, x: 3, y: 4 },
  { kind: 'right_click', at: 0, x: 5, y: 6 },
  { kind: 'middle_click', at: 0 },
  { kind: 'drag', at: 0, x: 1, y: 2, toX: 3, toY: 4 },
  { kind: 'drag', at: 0 },
  { kind: 'scroll', at: 0, x: 5, y: 6, direction: 'up', amount: 3 },
  { kind: 'scroll', at: 0 },
  { kind: 'scroll', at: 0, direction: 'left' },
  { kind: 'type', at: 0, text: 'hi "x"' },
  { kind: 'key', at: 0, keys: 'ctrl+s' },
  { kind: 'key', at: 0, keys: 'Tab', amount: 3 },
]

describe('recordedStepText', () => {
  it('describes steps in English', () => {
    expect(STEPS.map((s) => recordedStepText(s, 'en'))).toEqual([
      'Left click at (1, 2)',
      'Left click',
      'Double click at (3, 4)',
      'Right click at (5, 6)',
      'Middle click',
      'Drag from (1, 2) to (3, 4)',
      'Drag from (?, ?) to (?, ?)',
      'Scroll up 3× at (5, 6)',
      'Scroll down 1×',
      'Scroll left 1×',
      'Type "hi \\"x\\""',
      'Press ctrl+s',
      'Press Tab ×3',
    ])
  })

  // Portuguese on purpose: the pt-BR instructions of a plain recording.
  it('describes steps in Portuguese', () => {
    expect(STEPS.map((s) => recordedStepText(s, 'pt-BR'))).toEqual([
      'Clique em (1, 2)',
      'Clique',
      'Clique duplo em (3, 4)',
      'Clique com o botão direito em (5, 6)',
      'Clique com o botão do meio',
      'Arraste de (1, 2) até (3, 4)',
      'Arraste de (?, ?) até (?, ?)',
      'Role para cima 3× em (5, 6)',
      'Role para baixo 1×',
      'Role para a esquerda 1×',
      'Digite "hi \\"x\\""',
      'Pressione ctrl+s',
      'Pressione Tab ×3',
    ])
  })
})
