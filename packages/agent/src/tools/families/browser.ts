import type { ToolDefinition } from '../../llm/provider'
import { defineTools, describeSecretRefs, scalarText, shortUrl } from './kit'

const ref = { type: 'string', description: 'Element ref from the last browser_snapshot, e.g. "e12".' }
const snapshotAfter = {
  type: 'boolean',
  description: 'Also return the page snapshot after the action (saves a browser_snapshot call).',
}

/**
 * Text-based control of the bot's own Chrome (the one the user watches on its desktop), through a compact
 * accessibility snapshot with element refs. Far cheaper than reading pages from screenshots.
 */
const definitions = {
  browser_snapshot: {
    name: 'browser_snapshot',
    description:
      'Read the current tab of your Chrome as text: open dialogs and alerts first, then headings, text, links, ' +
      'buttons, fields (with their value, chips and hints; the focused one is marked) and rows, each actionable ' +
      'element with a ref like [e12]. By default only what is on screen. To find something anywhere on the ' +
      'page use `search` (matches names, labels, placeholders and text; "a|b" for alternatives). `full` lists ' +
      'the whole page in parts and is expensive: use it only when you must read everything.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Only lines containing this text, whole page ("to|recipients" = either).',
        },
        full: { type: 'boolean', description: 'Whole page instead of the visible part (expensive).' },
        page: { type: 'integer', minimum: 1, description: 'Part number when the result says there is more.' },
        max_tokens: { type: 'integer', minimum: 500, maximum: 10000, description: 'Default 4000.' },
      },
    },
  },
  browser_navigate: {
    name: 'browser_navigate',
    description:
      'Open a URL in the current tab ("back", "forward" and "reload" also work). Prefer URLs to clicking ' +
      "through menus: a site's own search URL when it has one, direct links from the snapshot.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, snapshot: snapshotAfter },
      required: ['url'],
    },
  },
  browser_click: {
    name: 'browser_click',
    description: 'Click an element by ref (scrolls it into view first).',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        double: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        snapshot: snapshotAfter,
      },
      required: ['ref'],
    },
  },
  browser_type: {
    name: 'browser_type',
    description:
      'Type into a field by ref (inputs, text areas, rich editors, comboboxes), replacing its text (append: ' +
      'true keeps it; chips already in the field stay). key presses a key after typing, e.g. "Enter" to ' +
      'submit or pick the highlighted suggestion, "Tab" to turn a typed address into a chip. The result ' +
      'tells what the field holds now and any dialog or error that appeared.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        text: { type: 'string' },
        append: { type: 'boolean' },
        key: { type: 'string', description: 'Key to press after typing, e.g. "Enter" or "Tab".' },
        submit: { type: 'boolean', description: 'Same as key: "Enter".' },
        snapshot: snapshotAfter,
      },
      required: ['ref', 'text'],
    },
  },
  browser_press_key: {
    name: 'browser_press_key',
    description:
      'Press a key or shortcut in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+a", ' +
      "or one of the site's own keyboard shortcuts.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        repeat: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 1.' },
        snapshot: snapshotAfter,
      },
      required: ['key'],
    },
  },
  browser_select_option: {
    name: 'browser_select_option',
    description: 'Choose option(s) of a <select> by ref, by value or visible label.',
    inputSchema: {
      type: 'object',
      properties: { ref, values: { type: 'array', items: { type: 'string' } }, snapshot: snapshotAfter },
      required: ['ref', 'values'],
    },
  },
  browser_scroll: {
    name: 'browser_scroll',
    description:
      'Scroll the page (or bring a ref into view) and return the new visible snapshot (snapshot: false to skip).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], description: 'Default down.' },
        amount: { type: 'number', minimum: 0.1, maximum: 10, description: 'Screens (default 1).' },
        ref: { type: 'string', description: 'Scroll this element into view instead.' },
        snapshot: { type: 'boolean' },
      },
    },
  },
  browser_wait_for: {
    name: 'browser_wait_for',
    description:
      'Wait until a text appears (or text_gone disappears) in the page, or for a number of seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        text_gone: { type: 'string' },
        seconds: { type: 'number', minimum: 0.1, maximum: 30, description: 'Max wait (default 10).' },
        snapshot: snapshotAfter,
      },
    },
  },
  browser_tabs: {
    name: 'browser_tabs',
    description:
      'List, open, switch to or close tabs. The tools act on the tab in front (most recently used).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'integer', minimum: 1, description: 'Tab number from list (select/close).' },
        url: { type: 'string', description: 'URL for a new tab.' },
      },
      required: ['action'],
    },
  },
} satisfies Record<string, ToolDefinition>

export type BrowserToolName = keyof typeof definitions

export const browserTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'browser_snapshot':
        return { kind: name, detail: a.search ? `“${view.clip(scalarText(a.search), 60)}”` : '' }
      case 'browser_navigate': {
        const url = scalarText(a.url).trim()
        if (/^(back|forward|reload)$/i.test(url)) return { kind: `browser_${url.toLowerCase()}`, detail: '' }
        return { kind: name, detail: view.full ? url : shortUrl(url, view) }
      }
      case 'browser_type':
        return { kind: name, detail: view.clip(describeSecretRefs(scalarText(a.text)), 60) }
      case 'browser_press_key':
        return { kind: name, detail: scalarText(a.key) }
      case 'browser_select_option':
        return {
          kind: name,
          detail: view.clip(
            Array.isArray(a.values) ? a.values.map(scalarText).join(', ') : scalarText(a.values),
            60,
          ),
        }
      case 'browser_wait_for':
        return { kind: name, detail: view.clip(scalarText(a.text) || scalarText(a.text_gone), 60) }
      case 'browser_tabs': {
        const action = scalarText(a.action) || 'list'
        const kind = ['new', 'select', 'close'].includes(action) ? `browser_tab_${action}` : name
        return { kind, detail: view.clip(scalarText(a.url), 60) }
      }
      case 'browser_click':
      case 'browser_scroll':
        return { kind: name, detail: '' }
    }
  },
  labels: {
    browser_snapshot: 'read page',
    browser_navigate: 'opened',
    browser_back: 'went back',
    browser_forward: 'went forward',
    browser_reload: 'reloaded',
    browser_click: 'clicked',
    browser_type: 'typed',
    browser_press_key: 'pressed',
    browser_select_option: 'chose',
    browser_scroll: 'scrolled',
    browser_wait_for: 'waited for',
    browser_tabs: 'tabs',
    browser_tab_new: 'new tab',
    browser_tab_select: 'switched tab',
    browser_tab_close: 'closed tab',
  },
})
