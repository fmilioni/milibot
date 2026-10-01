import type { ToolDefinition } from '../../llm/provider'
import { defineTools, describeSecretRefs, scalarText } from './kit'

export const SCREEN_WIDTH = 1280
export const SCREEN_HEIGHT = 800

const COMPUTER_ACTIONS = [
  'screenshot',
  'click',
  'double_click',
  'right_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'wait',
] as const
/** Max actions in one batched `computer` call. */
export const MAX_COMPUTER_BATCH = 20

const computerActionFields = {
  x: { type: 'integer', minimum: 0, maximum: SCREEN_WIDTH - 1 },
  y: { type: 'integer', minimum: 0, maximum: SCREEN_HEIGHT - 1 },
  to_x: { type: 'integer', minimum: 0, maximum: SCREEN_WIDTH - 1 },
  to_y: { type: 'integer', minimum: 0, maximum: SCREEN_HEIGHT - 1 },
  text: { type: 'string', description: 'Text to type (action=type).' },
  keys: { type: 'string', description: 'Key or combo in xdotool syntax (action=key).' },
  direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
  amount: { type: 'integer', minimum: 1, maximum: 30, description: 'Scroll clicks (default 3).' },
  ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'Wait duration (action=wait).' },
}

const definitions = {
  computer: {
    name: 'computer',
    description:
      `Operate your own Linux desktop (${SCREEN_WIDTH}x${SCREEN_HEIGHT}, XFCE). Use it only for graphical apps; ` +
      'to find or read information on the web use the web search/fetch tools, to work on websites the ' +
      'browser_* tools, and anything doable from a terminal or with files is faster ' +
      'there. Coordinates are screen ' +
      'pixels, exactly as seen in the screenshot (no scaling). Actions: screenshot; click/double_click/' +
      'right_click/move (x, y); drag (x, y → to_x, to_y); scroll (x, y, direction, amount clicks); type (text); ' +
      'key (keys, e.g. "ctrl+s", "Return", "alt+Tab"); wait (ms). Only `screenshot` returns an image: other ' +
      'actions return a short text confirmation, unless you set screenshot_after: true to also get the screen ' +
      'after the action. Batch: when you already know the next steps (click a field, type, press Return, ' +
      'wait for the page), send them as `actions: [...]` in ONE call instead of one call each; they run in ' +
      'order and screenshot_after shows the screen once, at the end. Look at the screen when you do not know ' +
      'what is on it and to verify results that matter; do not request screenshots you do not need.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...COMPUTER_ACTIONS] },
        ...computerActionFields,
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_COMPUTER_BATCH,
          description:
            'Several actions run in order in one call (instead of `action`); no screenshot inside.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: COMPUTER_ACTIONS.filter((a) => a !== 'screenshot') },
              ...computerActionFields,
            },
            required: ['action'],
          },
        },
        screenshot_after: {
          type: 'boolean',
          description: 'Also return a screenshot taken right after the action(s) (default false).',
        },
      },
    },
  },
} satisfies Record<string, ToolDefinition>

const POINTER_ACTIONS = new Set([
  'click',
  'double_click',
  'triple_click',
  'right_click',
  'middle_click',
  'move',
])

export const computerTools = defineTools({
  definitions,
  describe(name, a, view) {
    if (Array.isArray(a.actions)) return { kind: 'computer_batch', detail: String(a.actions.length) }
    const action = scalarText(a.action) || 'screenshot'
    if (action === 'type')
      return { kind: 'type', detail: view.clip(describeSecretRefs(scalarText(a.text)), 60) }
    if (action === 'key') return { kind: 'key', detail: scalarText(a.keys) }
    if (action === 'wait') return { kind: 'wait', detail: `${scalarText(a.ms) || '1000'} ms` }
    if (action === 'drag')
      return {
        kind: 'drag',
        detail: `(${scalarText(a.x)}, ${scalarText(a.y)}) → (${scalarText(a.to_x)}, ${scalarText(a.to_y)})`,
      }
    if (action === 'scroll')
      return { kind: 'scroll', detail: `${scalarText(a.direction) || 'down'} ${scalarText(a.amount) || '3'}` }
    if (action === 'screenshot') return { kind: 'screenshot', detail: '' }
    const point = typeof a.x === 'number' && typeof a.y === 'number' ? `(${a.x}, ${a.y})` : ''
    return { kind: POINTER_ACTIONS.has(action) ? action : 'click', detail: point }
  },
  labels: { computer_batch: 'screen actions' },
})
