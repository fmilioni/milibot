import { describe, expect, it } from 'vitest'

import {
  formatSnapshot,
  LIST_KEEP,
  type PageSnapshot,
  renderTree,
  searchLines,
  type SnapNode,
} from '../../../src/runtime/browser/snapshot'

function page(tree: SnapNode[], extra: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Inbox (2) - ana@example.com - Gmail',
    docId: 'doc1',
    next: 50,
    vw: 1280,
    vh: 720,
    scrollY: 0,
    scrollH: 720,
    tree,
    above: 0,
    below: 0,
    truncated: false,
    ...extra,
  }
}

const inbox: SnapNode[] = [
  {
    r: 'navigation',
    n: 'Labels',
    b: 1,
    c: [
      { r: 'link', n: 'Inbox 2 unread', ref: 'e1', st: 'current', h: '#inbox' },
      { r: 'link', n: 'Sent', ref: 'e2', h: '#sent' },
    ],
  },
  {
    r: 'main',
    b: 1,
    c: [
      { r: 'searchbox', n: 'Search mail', ref: 'e3', v: 'from:ana' },
      {
        r: 'grid',
        b: 1,
        c: [
          {
            r: 'row',
            ref: 'e10',
            b: 1,
            c: [
              { r: 'cell', b: 1, c: [{ r: 'checkbox', n: 'Select', ref: 'e11', st: 'unchecked', i: 1 }] },
              { r: 'cell', b: 1, c: ['Ana Souza'] },
              {
                r: 'cell',
                b: 1,
                c: [
                  { r: '', b: 1, c: ['Contract'] },
                  { r: '', b: 1, c: [' - attachment enclosed '] },
                ],
              },
              { r: 'cell', b: 1, c: ['10:32'] },
            ],
          },
        ],
      },
    ],
  },
]

describe('renderTree', () => {
  it('renders landmarks, fields with values, rows as one line with cells and inline refs', () => {
    expect(renderTree(inbox, false)).toEqual([
      '- navigation "Labels":',
      '  - link "Inbox 2 unread" [e1] [current] → #inbox',
      '  - link "Sent" [e2] → #sent',
      '- main:',
      '  - searchbox "Search mail" [e3] = "from:ana"',
      '  - grid:',
      '    - row [e10]: [checkbox: Select (unchecked)](e11) | Ana Souza | Contract · - attachment enclosed | 10:32',
    ])
  })

  it('keeps links inside text inline and drops a label that repeats the control name', () => {
    const tree: SnapNode[] = [
      { r: 'heading', lv: 1, b: 1, c: ['Debian'] },
      {
        r: 'paragraph',
        b: 1,
        c: ['Debian is a ', { r: 'link', n: 'free', ref: 'e4', i: 1 }, ' operating system.'],
      },
      { r: 'radio', n: 'Small', ref: 'e5', st: 'checked' },
      { r: '', b: 1, c: ['Small'] },
      { r: 'img', n: 'Logo' },
    ]
    expect(renderTree(tree, false)).toEqual([
      '- h1: Debian',
      '- Debian is a [free](e4) operating system.',
      '- radio "Small" [e5] [checked]',
      '- img "Logo"',
    ])
  })

  it('marks frames from other sites as unreadable and skips empty containers', () => {
    const tree: SnapNode[] = [
      { r: 'iframe', n: 'Ad', x: 1, b: 1, c: [] },
      { r: 'navigation', b: 1, c: [] },
      { r: 'list', b: 1, c: [{ r: 'listitem', b: 1, c: [{ r: 'link', n: 'Home', ref: 'e1' }] }] },
    ]
    expect(renderTree(tree, false)).toEqual([
      '- iframe "Ad" (other site: not readable here, use computer)',
      '- link "Home" [e1]',
    ])
  })

  it('summarizes long lists with a count in full snapshots', () => {
    const items: SnapNode[] = Array.from({ length: 300 }, (_, i) => ({
      r: 'listitem',
      b: 1 as const,
      c: [{ r: 'link', n: `Ref ${i}`, ref: `e${i + 1}` }],
    }))
    const lines = renderTree([{ r: 'list', n: 'References', b: 1, c: items }], true)
    expect(lines).toHaveLength(1 + LIST_KEEP + 1)
    expect(lines.at(-1)).toBe(`  - … ${300 - LIST_KEEP} more items here (use search to find one)`)
    expect(renderTree([{ r: 'list', n: 'References', b: 1, c: items }], false)).toHaveLength(301)
  })
})

describe('searchLines', () => {
  it('keeps matching lines with their containers, ignoring case and accents', () => {
    const lines = renderTree(inbox, false)
    const found = searchLines(lines, 'CONTRACT')
    expect(found.matches).toBe(1)
    expect(found.lines).toEqual([lines[3], lines[5], lines[6]])
    expect(searchLines(['- Crème brûlée ordered'], 'creme').matches).toBe(1)
  })
})

describe('formatSnapshot', () => {
  it('starts with the page, then the tree, within the token cap', () => {
    const out = formatSnapshot(page(inbox), { full: false, maxTokens: 4000, page: 1, tabs: 3 })
    expect(out.text.split('\n').slice(0, 4)).toEqual([
      'Page: Inbox (2) - ana@example.com - Gmail',
      'URL: https://mail.google.com/mail/u/0/#inbox',
      'Viewport 1280x720 · 3 tabs',
      '',
    ])
    expect(out.pages).toBe(1)
    expect(out.tokens).toBeLessThan(250)
  })

  it('splits long pages into parts and says how to get the next one', () => {
    const paragraphs: SnapNode[] = Array.from({ length: 200 }, (_, i) => ({
      r: 'paragraph',
      b: 1 as const,
      c: [`Paragraph ${i} ${'lorem ipsum '.repeat(20)}`],
    }))
    const first = formatSnapshot(page(paragraphs), { full: true, maxTokens: 1000, page: 1 })
    expect(first.pages).toBeGreaterThan(5)
    expect(first.tokens).toBeLessThanOrEqual(1000)
    expect(first.text).toContain(
      `Part 1 of ${first.pages}: call browser_snapshot again with page: 2 for more`,
    )
    expect(first.text).toContain('Paragraph 0 ')
    const second = formatSnapshot(page(paragraphs), { full: true, maxTokens: 1000, page: 2 })
    expect(second.text).not.toContain('Paragraph 0 ')
    const last = formatSnapshot(page(paragraphs), { full: true, maxTokens: 1000, page: 999 })
    expect(last.text).toContain(`Part ${first.pages} of ${first.pages} (last).`)
  })

  it('tells what is outside the viewport and how far the page is scrolled', () => {
    const out = formatSnapshot(page(inbox, { above: 3, below: 40, scrollY: 1440, scrollH: 7200 }), {
      full: false,
      maxTokens: 4000,
      page: 1,
    })
    expect(out.text).toContain('Viewport 1280x720 · scrolled 22% of 10 screens')
    expect(out.text).toContain('(~3 above, ~40 below not shown): search finds anything on the page')
  })

  it('answers a search with the matching lines only', () => {
    const out = formatSnapshot(page(inbox), { full: false, maxTokens: 4000, page: 1, search: 'nothing here' })
    expect(out.text).toContain('Search "nothing here": 0 matching lines')
    expect(out.text).toContain('(no matches)')
  })

  it('shows dialogs with their fields, chips, placeholders and hints, the focused element and modal notes', () => {
    const compose: SnapNode[] = [
      {
        r: 'alertdialog',
        n: 'Error',
        st: 'modal',
        b: 1,
        c: [
          { r: '', b: 1, c: ['The address was not recognized.'] },
          { r: 'button', n: 'OK', ref: 'e30' },
        ],
      },
      {
        r: 'dialog',
        n: 'New message',
        b: 1,
        c: [
          {
            r: 'option',
            n: 'Beatriz Ferreira',
            ref: 'e2',
            i: 1,
            c: [
              { r: '', i: 1, c: ['Beatriz Ferreira'] },
              { r: 'button', n: 'Remove recipient', ref: 'e1' },
            ],
          },
          {
            r: 'combobox',
            n: 'Recipients in To',
            ref: 'e3',
            st: 'focused',
            ch: ['Beatriz Ferreira <bia@example.com>', 'Message (invalid)'],
            v: 'Car',
          },
          { r: 'textbox', n: 'Message body', ref: 'e7', st: 'multiline', ph: 'Write something' },
          { r: 'textbox', n: 'ZIP code', ref: 'e8', st: 'invalid', d: 'Enter a valid ZIP code' },
        ],
      },
    ]
    const out = formatSnapshot(
      page(compose, { focus: { r: 'combobox', n: 'Recipients in To', ref: 'e3' }, behindModal: true }),
      { full: false, maxTokens: 4000, page: 1 },
    )
    expect(out.text).toContain('Focused: combobox "Recipients in To" [e3]')
    expect(out.text).toContain(
      [
        '- alertdialog "Error" [modal]:',
        '  - The address was not recognized.',
        '  - button "OK" [e30]',
        '- dialog "New message":',
        '  - option "Beatriz Ferreira" [e2] · [button: Remove recipient](e1)',
        '  - combobox "Recipients in To" [e3] [focused] chips: "Beatriz Ferreira <bia@example.com>", "Message (invalid)" = "Car"',
        '  - textbox "Message body" [e7] [multiline] placeholder "Write something"',
        '  - textbox "ZIP code" [e8] [invalid] — hint: "Enter a valid ZIP code"',
      ].join('\n'),
    )
    expect(out.text).toContain('A modal dialog is open: the page behind it is not listed')
  })

  it('searches names, placeholders and hints without accents or case, with alternatives', () => {
    const fields: SnapNode[] = [
      { r: 'textbox', n: 'Subject', ref: 'e1' },
      { r: 'textbox', n: 'Message', ref: 'e2', ph: 'Write here' },
      { r: 'combobox', n: 'Café menu', ref: 'e3' },
    ]
    const lines = renderTree(fields, true)
    expect(searchLines(lines, 'CAFE').lines).toEqual(['- combobox "Café menu" [e3]'])
    expect(searchLines(lines, 'write|subject').matches).toBe(2)
  })
})
