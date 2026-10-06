// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { splitFrameContext } from './canvas'
import {
  elementContextPrefix,
  type ElementRef,
  elementRef,
  parseSource,
  sourceSnippet,
  splitElementContext,
  splitSourceDocument,
} from './element-ref'

const names = { frameId: 'frm_1', frameName: 'Dashboard', designId: 'dsg_1', designName: 'Onboarding' }

/** A compiled page: the body holds the frame's HTML, as the daemon's compiler writes it. */
function page(html: string): Document {
  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = html
  return doc
}

describe('parseSource', () => {
  it('finds elements by offsets, with implied ends and void elements', () => {
    const html = '<ul>\n  <li class="a">One\n  <li>Two<br></li>\n</ul><p>x<div>y</div>'
    const [ul, p, div] = parseSource(html)
    expect(ul?.children.map((li) => html.slice(li.start, li.openEnd))).toEqual(['<li class="a">', '<li>'])
    expect(ul?.children[1]?.children.map((c) => c.tag)).toEqual(['br'])
    expect(html.slice(ul?.start, ul?.end)).toBe('<ul>\n  <li class="a">One\n  <li>Two<br></li>\n</ul>')
    expect([p?.tag, div?.tag]).toEqual(['p', 'div'])
  })

  it('skips comments and the text of style, and reads quoted ">" in attributes', () => {
    const html = '<!-- <b> --><style>a > b { color: red }</style><a title="1 > 0" href="#">go</a>'
    const parsed = parseSource(html)
    expect(parsed.map((el) => el.tag)).toEqual(['style', 'a'])
    expect(parsed[1]?.attrs).toEqual({ title: '1 > 0', href: '#' })
  })

  it('closes self-closing SVG children', () => {
    const [svg] = parseSource('<svg viewBox="0 0 4 4"><path d="M0 0"/><circle r="1"/></svg>')
    expect(svg?.children.map((c) => c.tag)).toEqual(['path', 'circle'])
  })
})

describe('sourceSnippet', () => {
  it('uses the opening tag when it is unique in the HTML and CSS', () => {
    const html =
      '<div class="card"><button class="btn">Save</button><button class="btn ghost">No</button></div>'
    const [card] = parseSource(html)
    expect(sourceSnippet(html, '', card?.children[0] as never)).toEqual({
      text: '<button class="btn">',
      occurrence: 1,
      of: 1,
    })
  })

  it('takes the whole element when the opening tag repeats', () => {
    const html = '<li class="row">Alice</li><li class="row">Bob</li>'
    const [, bob] = parseSource(html)
    expect(sourceSnippet(html, '', bob as never)?.text).toBe('<li class="row">Bob</li>')
  })

  it('says which occurrence it is when even the element repeats', () => {
    const html = '<hr class="x"><hr class="x">'
    const [, second] = parseSource(html)
    expect(sourceSnippet(html, '', second as never)).toEqual({ text: '<hr class="x">', occurrence: 2, of: 2 })
    expect(sourceSnippet('<b>', '<b>', parseSource('<b>')[0] as never)?.of).toBe(2)
  })
})

describe('splitSourceDocument', () => {
  it('reads the frame HTML and CSS out of the source document', () => {
    const doc = [
      '<!-- Frame "A" … -->',
      '<link rel="stylesheet" href="tokens.css">',
      '<style>',
      '.x { color: red }',
      '</style>',
      '<div data-theme="light">',
      '<main><div>hi</div></main>',
      '</div>',
      '',
    ].join('\n')
    expect(splitSourceDocument(doc)).toEqual({ html: '<main><div>hi</div></main>', css: '.x { color: red }' })
    expect(splitSourceDocument('<div data-theme="light">\n<p>x</p>\n</div>\n')).toBeNull()
    expect(splitSourceDocument('\n<div data-theme="light">\n<p>x</p>\n</div>\n')).toEqual({
      html: '<p>x</p>',
      css: '',
    })
  })
})

describe('elementRef', () => {
  const source = [
    '<main class="p-6">',
    '  <h1>Hi</h1>',
    '  <nav data-id="menu"><a href="#">Home</a><a href="#" class="on">Docs <i data-icon="lucide:book"></i></a></nav>',
    '  <div data-art="hero" class="w-40"></div>',
    '</main>',
  ].join('\n')
  // What the compiler makes of it: the icon is an <svg>, the art an <img>.
  const doc = page(
    '<main class="p-6"><h1>Hi</h1><nav data-id="menu"><a href="#">Home</a><a href="#" class="on">Docs <svg data-icon="lucide:book"><path d="M0"></path></svg></a></nav><img class="w-40" src="asset:x"></main>',
  )

  it('points at an element by its path and its unique opening tag', () => {
    const docs = doc.querySelector('a.on') as Element
    expect(elementRef(docs, names, { html: source, css: '' })).toEqual({
      ...names,
      tag: 'a',
      label: 'Docs',
      selector: 'body > main:nth-child(1) > nav[data-id="menu"]:nth-child(2) > a:nth-child(2)',
      snippet: { text: '<a href="#" class="on">', occurrence: 1, of: 1 },
    })
  })

  it('gives the source of an icon and of art as written', () => {
    const icon = elementRef(doc.querySelector('svg') as Element, names, { html: source, css: '' })
    expect(icon.tag).toBe('i')
    expect(icon.label).toBe('lucide:book')
    expect(icon.selector).toBe(
      'body > main:nth-child(1) > nav[data-id="menu"]:nth-child(2) > a:nth-child(2) > i:nth-child(1)',
    )
    expect(icon.snippet?.text).toBe('<i data-icon="lucide:book">')
    const art = elementRef(doc.querySelector('img') as Element, names, { html: source, css: '' })
    expect([art.tag, art.snippet?.text]).toEqual(['div', '<div data-art="hero" class="w-40">'])
  })

  it('keeps the selector when the source is unknown or does not line up', () => {
    const h1 = doc.querySelector('h1') as Element
    expect(elementRef(h1, names, null)).toMatchObject({
      tag: 'h1',
      selector: 'body > main:nth-child(1) > h1:nth-child(1)',
      snippet: null,
    })
    expect(elementRef(h1, names, { html: '<section><p>x</p></section>', css: '' }).snippet).toBeNull()
  })
})

describe('the element prefix', () => {
  const ref: ElementRef = {
    ...names,
    tag: 'button',
    label: 'Save',
    selector: 'body > main:nth-child(1) > button:nth-child(3)',
    snippet: { text: '<button class="btn">', occurrence: 1, of: 1 },
  }

  it('writes the element, the selector and the source before the text', () => {
    expect(elementContextPrefix(ref)).toBe(
      [
        '[Element <button> "Save" in frame "Dashboard" (frm_1) of the design "Onboarding" (dsg_1)]',
        'Selector: body > main:nth-child(1) > button:nth-child(3)',
        'Source: <button class="btn">',
      ].join('\n'),
    )
    expect(
      elementContextPrefix({
        ...ref,
        label: '',
        snippet: { text: '<li\n  class="x">', occurrence: 2, of: 3 },
      }),
    ).toBe(
      [
        '[Element <button> in frame "Dashboard" (frm_1) of the design "Onboarding" (dsg_1)]',
        'Selector: body > main:nth-child(1) > button:nth-child(3)',
        'Source (occurrence 2 of 3), as a JSON string: "<li\\n  class=\\"x\\">"',
      ].join('\n'),
    )
  })

  it('reads back as a chip and the text, with or without the label and source', () => {
    const text = 'make it bigger\nand blue'
    expect(splitFrameContext(`${elementContextPrefix(ref)}\n${text}`)).toEqual({
      frame: 'Dashboard',
      element: { tag: 'button', label: 'Save', frame: 'Dashboard' },
      text,
    })
    const bare = elementContextPrefix({ ...ref, label: '', snippet: null, frameName: 'A "quoted" (one)' })
    expect(splitElementContext(`${bare}\nhi`)).toEqual({
      element: { tag: 'button', label: '', frame: 'A "quoted" (one)' },
      text: 'hi',
    })
    expect(splitElementContext('[Element <b> in frame]\nhi')).toBeNull()
  })
})
