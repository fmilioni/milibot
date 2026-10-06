import { trailOf } from './element-pick'

/**
 * What the bot gets about an element the user pointed at: a header line, a CSS path from the page's top and
 * the element's opening tag as written in the frame's HTML (unique there, so `design_edit_frame` takes it as
 * `old_text`). Positions are the same in the source and in the compiled page: icons and art change their tag
 * but keep their place, and only the elements the compiler drops (scripts, frames, links) are skipped.
 */

/** An element of a frame's source, by character offsets. */
export interface SourceElement {
  tag: string
  start: number
  /** End of the opening tag. */
  openEnd: number
  end: number
  /** Removed by the compiler: not in the page. */
  dropped: boolean
  attrs: Record<string, string>
  children: SourceElement[]
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])
/** The compiler's DROPPED list (daemon `design/html.ts`). */
const DROPPED = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'base',
  'meta',
  'link',
  'noscript',
])
/** Elements an opening tag closes implicitly when one is the innermost open element. */
const CLOSED_BY: Record<string, readonly string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
}
const CLOSES_P =
  /^(address|article|aside|blockquote|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul)$/

const OPEN_TAG =
  /<([a-zA-Z][\w:.-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?|\s*\/(?!>))*)\s*(\/?)>/y
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function attributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR)) attrs[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return attrs
}

/** The elements of a frame's HTML as written (a forgiving scan; enough for the HTML bots write). */
export function parseSource(html: string): SourceElement[] {
  const root: SourceElement = {
    tag: '#root',
    start: 0,
    openEnd: 0,
    end: html.length,
    dropped: false,
    attrs: {},
    children: [],
  }
  const stack: SourceElement[] = [root]
  const top = () => stack[stack.length - 1] as SourceElement
  const close = (el: SourceElement, end: number) => {
    el.end = end
    stack.pop()
  }
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    i = lt
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const closing = /^<\/([a-zA-Z][\w:.-]*)\s*>/.exec(html.slice(i, i + 200))
    if (closing) {
      const tag = (closing[1] as string).toLowerCase()
      const end = i + closing[0].length
      const at = stack.findLastIndex((el) => el.tag === tag)
      if (at > 0) while (stack.length > at) close(top(), end)
      i = end
      continue
    }
    OPEN_TAG.lastIndex = i
    const open = OPEN_TAG.exec(html)
    if (!open) {
      i++
      continue
    }
    const tag = (open[1] as string).toLowerCase()
    const openEnd = i + open[0].length
    while (stack.length > 1) {
      const current = top().tag
      if (CLOSED_BY[tag]?.includes(current) || (current === 'p' && CLOSES_P.test(tag))) close(top(), i)
      else break
    }
    const el: SourceElement = {
      tag,
      start: i,
      openEnd,
      end: openEnd,
      dropped: DROPPED.has(tag),
      attrs: attributes(open[2] ?? ''),
      children: [],
    }
    top().children.push(el)
    i = openEnd
    if (RAW_TEXT.has(tag)) {
      const closeAt = html.toLowerCase().indexOf(`</${tag}`, openEnd)
      const gt = closeAt < 0 ? -1 : html.indexOf('>', closeAt)
      el.end = gt < 0 ? html.length : gt + 1
      i = el.end
    } else if (!VOID.has(tag) && !open[3]) stack.push(el)
  }
  while (stack.length > 1) close(top(), html.length)
  return root.children
}

/** Whether a page element is what a source element compiles to. */
function compilesTo(source: SourceElement, el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if ('data-icon' in source.attrs && source.tag !== 'svg') return tag === 'svg' || tag === 'span'
  if ('data-art' in source.attrs) return tag === 'img'
  return source.tag === tag
}

const indexOf = (el: Element) => Array.prototype.indexOf.call(el.parentElement?.children ?? [], el)

/** The source elements along a page trail (`trailOf`), or null when they don't line up. */
function sourceTrail(
  source: readonly SourceElement[],
  page: readonly Element[],
): SourceElement[] | null {
  const trail: SourceElement[] = []
  let siblings = source
  for (const el of page) {
    const match = siblings.filter((s) => !s.dropped)[indexOf(el)]
    if (!match || !compilesTo(match, el)) return null
    trail.push(match)
    siblings = match.children
  }
  return trail
}

/** `#id` or `[data-id="…"]` of an element, if it has one. */
function idOf(el: Element): string {
  const dataId = el.getAttribute('data-id')
  if (dataId) return `[data-id="${dataId.replace(/["\\]/g, '\\$&')}"]`
  const id = el.getAttribute('id')
  if (!id) return ''
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/["\\]/g, '\\$&')}"]`
}

/** `body > main:nth-child(2) > button#save:nth-child(1)`, with the tags as written in the source. */
function selectorOf(page: readonly Element[], tags: readonly string[]): string {
  const parts = page.map((el, i) => `${tags[i]}${idOf(el)}:nth-child(${indexOf(el) + 1})`)
  return ['body', ...parts].join(' > ')
}

const MAX_SNIPPET = 1000

function occurrences(text: string, part: string): number[] {
  const at: number[] = []
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) at.push(i)
  return at
}

/**
 * Text of the source that finds the element: its opening tag when that is unique in the frame's HTML and
 * CSS, else the whole element when short enough and unique, else the opening tag and which occurrence it is.
 */
export function sourceSnippet(
  html: string,
  css: string,
  el: SourceElement,
): { text: string; occurrence: number; of: number } | null {
  const open = html.slice(el.start, el.openEnd)
  if (open.length > MAX_SNIPPET) return null
  const all = `${html}\n${css}`
  const openAt = occurrences(all, open)
  if (openAt.length === 1) return { text: open, occurrence: 1, of: 1 }
  const whole = html.slice(el.start, el.end)
  if (whole.length <= MAX_SNIPPET && occurrences(all, whole).length === 1)
    return { text: whole, occurrence: 1, of: 1 }
  return { text: open, occurrence: openAt.indexOf(el.start) + 1, of: openAt.length }
}

/** The frame's HTML and CSS from its source document (`getDesignFrameSource`, daemon `sourceDocument`). */
export function splitSourceDocument(doc: string): { html: string; css: string } | null {
  const styleAt = doc.indexOf('\n<style>\n')
  const styleEnd = styleAt < 0 ? -1 : doc.indexOf('\n</style>\n', styleAt)
  const css = styleAt < 0 || styleEnd < 0 ? '' : doc.slice(styleAt + '\n<style>\n'.length, styleEnd)
  const openAt = doc.indexOf('\n<div data-theme="', Math.max(0, styleEnd))
  const openEnd = openAt < 0 ? -1 : doc.indexOf('">\n', openAt)
  const closeAt = doc.lastIndexOf('\n</div>')
  if (openEnd < 0 || closeAt < openEnd) return null
  return { html: doc.slice(openEnd + 3, closeAt), css }
}

/** What the user pointed at, as the bot and the chat chip get it. */
export interface ElementRef {
  /** Tag as written (`i` for an icon, `div` for art). */
  tag: string
  /** Its text, label or icon name, short; empty when it has none. */
  label: string
  selector: string
  snippet: { text: string; occurrence: number; of: number } | null
  frameId: string
  frameName: string
  designId: string
  designName: string
}

const LABEL_CHARS = 40

/** The reference of a page element; `source` is the frame's HTML and CSS as written, when known. */
export function elementRef(
  el: Element,
  names: Pick<ElementRef, 'frameId' | 'frameName' | 'designId' | 'designName'>,
  source: { html: string; css: string } | null,
): ElementRef {
  const page = trailOf(el)
  const trail = source ? sourceTrail(parseSource(source.html), page) : null
  const tags = page.map((p, i) => trail?.[i]?.tag ?? p.tagName.toLowerCase())
  const target = trail?.at(-1)
  return {
    ...names,
    tag: tags.at(-1) ?? el.tagName.toLowerCase(),
    label: labelOf(el),
    selector: selectorOf(page, tags),
    snippet: source && target ? sourceSnippet(source.html, source.css, target) : null,
  }
}

/** A short name for a page element: its text, else its label, alt text or icon. */
function labelOf(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const label =
    text ||
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    el.getAttribute('title') ||
    el.getAttribute('data-icon') ||
    el.getAttribute('placeholder') ||
    ''
  const clean = label.replace(/"/g, "'").replace(/\s+/g, ' ').trim()
  return clean.length > LABEL_CHARS ? `${clean.slice(0, LABEL_CHARS - 1)}…` : clean
}

/** The lines the message starts with when it is about an element. */
export function elementContextPrefix(ref: ElementRef): string {
  const label = ref.label ? ` "${ref.label}"` : ''
  const lines = [
    `[Element <${ref.tag}>${label} in frame "${ref.frameName}" (${ref.frameId}) of the design "${ref.designName}" (${ref.designId})]`,
    `Selector: ${ref.selector}`,
  ]
  const s = ref.snippet
  if (s) {
    const which = s.of > 1 ? ` (occurrence ${s.occurrence} of ${s.of})` : ''
    lines.push(
      s.text.includes('\n')
        ? `Source${which}, as a JSON string: ${JSON.stringify(s.text)}`
        : `Source${which}: ${s.text}`,
    )
  }
  return lines.join('\n')
}

export interface ElementContext {
  tag: string
  label: string
  frame: string
}

const ELEMENT_HEADER =
  /^\[Element <([^>\s]+)>(?: "([^"]*)")? in frame "(.+)" \(([^()\s]+)\) of the design "(.+)" \(([^()\s]+)\)\]\n?/
const REFERENCE_LINE = /^(Selector: |Source( \(occurrence \d+ of \d+\))?(, as a JSON string)?: ).*\n?/

/** Splits a message about an element into the element and the text (null when it is not one). */
export function splitElementContext(content: string): { element: ElementContext; text: string } | null {
  const header = ELEMENT_HEADER.exec(content)
  if (!header) return null
  let rest = content.slice(header[0].length)
  for (let line = REFERENCE_LINE.exec(rest); line; line = REFERENCE_LINE.exec(rest))
    rest = rest.slice(line[0].length)
  return {
    element: { tag: header[1] as string, label: header[2] ?? '', frame: header[3] as string },
    text: rest,
  }
}
