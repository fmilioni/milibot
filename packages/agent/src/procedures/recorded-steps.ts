import type { Language, RecordedStep } from '@milibot/shared'

type Direction = NonNullable<RecordedStep['direction']>

interface RecordedStepTexts {
  at: string
  click: string
  double_click: string
  right_click: string
  middle_click: string
  dragFrom: string
  dragTo: string
  scroll: string
  type: string
  key: string
  directions: Record<Direction, string>
}

// Portuguese on purpose: plain recordings become instructions in the user's language.
const PROCEDURE_STEP_TEXTS: Record<Language, RecordedStepTexts> = {
  en: {
    at: 'at',
    click: 'Left click',
    double_click: 'Double click',
    right_click: 'Right click',
    middle_click: 'Middle click',
    dragFrom: 'Drag from',
    dragTo: 'to',
    scroll: 'Scroll',
    type: 'Type',
    key: 'Press',
    directions: { up: 'up', down: 'down', left: 'left', right: 'right' },
  },
  'pt-BR': {
    at: 'em',
    click: 'Clique',
    double_click: 'Clique duplo',
    right_click: 'Clique com o botão direito',
    middle_click: 'Clique com o botão do meio',
    dragFrom: 'Arraste de',
    dragTo: 'até',
    scroll: 'Role para',
    type: 'Digite',
    key: 'Pressione',
    directions: { up: 'cima', down: 'baixo', left: 'a esquerda', right: 'a direita' },
  },
}

export function recordedStepText(step: RecordedStep, language: Language): string {
  const t = PROCEDURE_STEP_TEXTS[language]
  const at = step.x !== undefined && step.y !== undefined ? ` ${t.at} (${step.x}, ${step.y})` : ''
  switch (step.kind) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
      return `${t[step.kind]}${at}`
    case 'drag':
      return `${t.dragFrom} (${step.x ?? '?'}, ${step.y ?? '?'}) ${t.dragTo} (${step.toX ?? '?'}, ${step.toY ?? '?'})`
    case 'scroll':
      return `${t.scroll} ${t.directions[step.direction ?? 'down']} ${step.amount ?? 1}×${at}`
    case 'type':
      return `${t.type} ${JSON.stringify(step.text ?? '')}`
    case 'key':
      return `${t.key} ${step.keys ?? ''}${(step.amount ?? 1) > 1 ? ` ×${step.amount}` : ''}`
  }
}
