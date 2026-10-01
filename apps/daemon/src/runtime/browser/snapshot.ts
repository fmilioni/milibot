import { estimateTokens, foldText } from '@milibot/shared'

/** Tree returned by the page script (`page-script.ts`): a string is text. */
export type SnapNode = string | SnapElement

interface SnapElement {
  /** Role; '' for generic containers. */
  r: string
  n?: string
  ref?: string
  /** Heading level. */
  lv?: number
  /** Comma-separated states (checked, expanded, selected, disabled, focused…). */
  st?: string
  v?: string
  h?: string
  /** Block-level box (line break around it). */
  b?: 1
  /** Inline box. */
  i?: 1
  /** Cross-origin frame whose content is not readable. */
  x?: 1
  /** Chips of a recipient/tag field ("Ana <ana@x.com>", "Foo (invalid)"). */
  ch?: string[]
  /** Placeholder the name does not already say. */
  ph?: string
  /** Hint or error message (aria-describedby / aria-errormessage). */
  d?: string
  c?: SnapNode[]
}

export interface PageSnapshot {
  url: string
  title: string
  docId: string
  next: number
  vw: number
  vh: number
  scrollY: number
  scrollH: number
  tree: SnapNode[]
  above: number
  below: number
  truncated: boolean
  /** Element with the keyboard focus, when it is on the listed page. */
  focus?: { r: string; n?: string; ref?: string } | null
  /** A modal dialog is open and the page behind it was left out. */
  behindModal?: boolean
}

export interface SnapshotFormatOptions {
  full: boolean
  maxTokens: number
  /** 1-based. */
  page: number
  search?: string
  tabs?: number
}

export interface FormattedSnapshot {
  text: string
  tokens: number
  pages: number
}

export const DEFAULT_SNAPSHOT_TOKENS = 4000
/** Parts of a full snapshot are smaller: the whole page is rarely needed, search usually is. */
export const DEFAULT_FULL_SNAPSHOT_TOKENS = 2500
const MAX_SNAPSHOT_TOKENS = 10_000
/** Lines a container shows in a full snapshot before the rest is summarized as a count. */
export const LIST_KEEP = 40
const LIST_LIMIT = 50
const TEXT_LINE_CHARS = 2000

const LEAF_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
  'img',
  'progressbar',
  'meter',
  'clickable',
])
/** Containers that only group their content: no line of their own. */
const TRANSPARENT_ROLES = new Set([
  '',
  'paragraph',
  'listitem',
  'rowgroup',
  'tabpanel',
  'figure',
  'blockquote',
])
/** Transparent unless they have a name. */
const NAMED_ONLY_ROLES = new Set(['list', 'group', 'article'])
const INLINE_LINE_ROLES = new Set([
  'heading',
  'row',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'alert',
  'status',
])
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader'])
/** Containers of repeated items, whose long runs are summarized in full snapshots (not article text). */
const LIST_ROLES = new Set([
  'list',
  'listbox',
  'menu',
  'menubar',
  'tree',
  'grid',
  'table',
  'treegrid',
  'rowgroup',
  'navigation',
  'tablist',
])

function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`
}

function clipText(text: string, max = TEXT_LINE_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function states(node: SnapElement): string {
  return node.st
    ? node.st
        .split(',')
        .map((s) => ` [${s}]`)
        .join('')
    : ''
}

function chips(node: SnapElement): string {
  return node.ch?.length ? ` chips: ${node.ch.map(quote).join(', ')}` : ''
}

/** Value, placeholder and hint of a field: ` = "abc" placeholder "Subject" — hint: "…"`. */
function fieldExtras(node: SnapElement, max = 300): string {
  let out = ''
  if (node.v !== undefined && node.v !== '') out += ` = ${quote(clipText(node.v, max))}`
  if (node.ph) out += ` placeholder ${quote(node.ph)}`
  if (node.d) out += ` — hint: ${quote(node.d)}`
  return out
}

/** One line for an element on its own: `- link "Docs" [e4] → /docs`. */
function leafLine(node: SnapElement): string {
  const parts = [node.r]
  if (node.n) parts.push(quote(node.n))
  if (node.ref) parts.push(`[${node.ref}]`)
  let line = parts.join(' ') + states(node) + chips(node) + fieldExtras(node)
  if (node.h) line += ` → ${node.h}`
  return line
}

function inlineLeaf(node: SnapElement): string {
  if (!node.ref) return node.n ?? ''
  const label =
    node.r === 'link' || node.r === 'clickable'
      ? (node.n ?? node.r)
      : `${node.r}${node.n ? `: ${node.n}` : ''}`
  const extra = [
    node.st?.replace(/,/g, ', '),
    node.ch?.length ? `chips: ${node.ch.map(quote).join(', ')}` : '',
    node.v ? `= ${quote(clipText(node.v, 100))}` : '',
    node.ph && !node.v ? `placeholder ${quote(node.ph)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `[${label}${extra ? ` (${extra})` : ''}](${node.ref})`
}

/** Controls inside an item (a chip's remove button), as inline refs. */
function innerRefs(nodes: SnapNode[] | undefined): string[] {
  const out: string[] = []
  for (const node of nodes ?? []) {
    if (typeof node === 'string') continue
    if (node.ref) out.push(inlineLeaf(node))
    else out.push(...innerRefs(node.c))
  }
  return out
}

/** An item role that wraps other controls: listed as a container, its text being its name. */
function isWrapper(node: SnapElement): boolean {
  return LEAF_ROLES.has(node.r) && !!node.c
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

/** Everything under `nodes` on one line; block boundaries become " · ", cells " | ". */
function inlineText(nodes: SnapNode[] | undefined): string {
  if (!nodes) return ''
  const out: string[] = []
  let current = ''
  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim()
    if (text) out.push(text)
    current = ''
  }
  for (const node of nodes) {
    if (typeof node === 'string') {
      current += node
      continue
    }
    if (LEAF_ROLES.has(node.r)) {
      const piece = [inlineLeaf(node), ...(isWrapper(node) ? innerRefs(node.c) : [])]
        .filter(Boolean)
        .join(' ')
      if (piece) current += (current && !/\s$/.test(current) && node.b ? ' ' : '') + piece
      continue
    }
    if (node.r === 'iframe' && node.x) {
      flush()
      out.push(`(frame${node.n ? ` ${quote(node.n)}` : ''} not readable)`)
      continue
    }
    if (node.b || CELL_ROLES.has(node.r) || node.r === 'row') {
      flush()
      const inner = node.r === 'heading' ? inlineText(node.c) : inlineText(node.c)
      if (inner) out.push(node.ref ? `[${inner}](${node.ref})` : inner)
      continue
    }
    current += inlineText(node.c)
  }
  flush()
  return out.join(' · ')
}

function rowLine(node: SnapElement): string {
  const cells: string[] = []
  const loose: SnapNode[] = []
  for (const child of node.c ?? []) {
    if (typeof child !== 'string' && CELL_ROLES.has(child.r)) {
      if (loose.length) cells.push(inlineText(loose.splice(0)))
      const text = inlineText(child.c)
      cells.push(child.ref ? `[${text || child.r}](${child.ref})` : text)
    } else loose.push(child)
  }
  if (loose.length) cells.push(inlineText(loose))
  const body = cells.filter(Boolean).join(' | ')
  return `row${node.ref ? ` [${node.ref}]` : ''}${states(node)}${body ? `: ${body}` : ''}`
}

interface Line {
  depth: number
  text: string
}

class Renderer {
  readonly lines: Line[] = []

  constructor(private readonly full: boolean) {}

  private lastLeaf: { depth: number; name: string; index: number } | null = null

  private push(depth: number, text: string, leafName?: string): void {
    this.lines.push({ depth, text })
    this.lastLeaf = leafName ? { depth, name: leafName, index: this.lines.length - 1 } : null
  }

  /** Label text right after the control it names ("radio "Small"" then "Small"). */
  private repeatsLastName(depth: number, text: string): boolean {
    const last = this.lastLeaf
    return !!last && last.depth === depth && last.index === this.lines.length - 1 && last.name === text
  }

  /** Renders a container's children; long runs of items in a list-like container are summarized. */
  block(nodes: SnapNode[] | undefined, depth: number, list = false): void {
    const start = this.lines.length
    this.children(nodes, depth)
    if (!this.full || !list) return
    const own = this.lines.slice(start).filter((l) => l.depth === depth).length
    if (own <= LIST_LIMIT) return
    let kept = 0
    let cut = this.lines.length
    for (let i = start; i < this.lines.length; i++) {
      if ((this.lines[i] as Line).depth === depth && ++kept > LIST_KEEP) {
        cut = i
        break
      }
    }
    this.lines.splice(cut)
    this.push(depth, `… ${own - LIST_KEEP} more items here (use search to find one)`)
  }

  private children(nodes: SnapNode[] | undefined, depth: number): void {
    let run: SnapNode[] = []
    const flush = () => {
      if (run.length === 0) return
      const hasText = run.some((n) => typeof n === 'string' && !isBlank(n))
      if (hasText) {
        const text = inlineText(run)
        if (text && !this.repeatsLastName(depth, text)) this.push(depth, clipText(text))
      } else {
        for (const n of run) if (typeof n !== 'string') this.push(depth, leafLine(n), n.n)
      }
      run = []
    }
    for (const node of nodes ?? []) {
      if (typeof node === 'string') {
        run.push(node)
        continue
      }
      if (isWrapper(node)) {
        flush()
        const refs = innerRefs(node.c)
        this.push(depth, `${leafLine(node)}${refs.length ? ` · ${refs.join(' ')}` : ''}`, node.n)
        continue
      }
      if (LEAF_ROLES.has(node.r)) {
        if (node.i) run.push(node)
        else {
          flush()
          this.push(depth, leafLine(node), node.n)
        }
        continue
      }
      if (!node.b && !node.r) {
        run.push(...(node.c ?? []))
        continue
      }
      flush()
      this.element(node, depth)
    }
    flush()
  }

  private element(node: SnapElement, depth: number): void {
    const role = node.r
    if (role === 'iframe') {
      if (node.x) {
        this.push(
          depth,
          `iframe${node.n ? ` ${quote(node.n)}` : ''} (other site: not readable here, use computer)`,
        )
        return
      }
      this.push(depth, `iframe${node.n ? ` ${quote(node.n)}` : ''}:`)
      this.block(node.c, depth + 1)
      return
    }
    if (role === 'row') {
      this.push(depth, rowLine(node))
      return
    }
    if (INLINE_LINE_ROLES.has(role)) {
      const text = inlineText(node.c) || node.n || ''
      if (!text && !node.ref) return
      const label = role === 'heading' ? `h${node.lv ?? 2}` : role
      this.push(depth, `${label}${node.ref ? ` [${node.ref}]` : ''}${states(node)}: ${clipText(text)}`)
      return
    }
    if (role === 'listitem' && node.ref) {
      this.push(depth, `listitem [${node.ref}]${states(node)}: ${clipText(inlineText(node.c))}`)
      return
    }
    if (TRANSPARENT_ROLES.has(role) || (NAMED_ONLY_ROLES.has(role) && !node.n)) {
      this.block(node.c, depth, LIST_ROLES.has(role))
      return
    }
    const start = this.lines.length
    this.push(
      depth,
      `${role}${node.n ? ` ${quote(node.n)}` : ''}${node.ref ? ` [${node.ref}]` : ''}${states(node)}${fieldExtras(node, 100)}:`,
    )
    this.block(node.c, depth + 1, LIST_ROLES.has(role))
    if (this.lines.length === start + 1) this.lines.pop()
  }
}

/** Renders the page tree as an indented YAML-ish list (`- role "name" [ref]`). */
export function renderTree(tree: SnapNode[], full: boolean): string[] {
  const renderer = new Renderer(full)
  renderer.block(tree, 0)
  return renderer.lines.map((l) => `${'  '.repeat(l.depth)}- ${l.text}`)
}

/**
 * Lines that contain the query (accent/case-insensitive; `a|b` matches either), each with the container
 * lines above it.
 */
export function searchLines(lines: string[], query: string): { lines: string[]; matches: number } {
  const needles = query
    .split('|')
    .map((q) => foldText(q.trim()))
    .filter(Boolean)
  const keep = new Set<number>()
  let matches = 0
  const indent = (line: string) => line.length - line.trimStart().length
  lines.forEach((line, i) => {
    const folded = foldText(line)
    if (!needles.some((needle) => folded.includes(needle))) return
    matches++
    keep.add(i)
    let level = indent(line)
    for (let j = i - 1; j >= 0 && level > 0; j--) {
      const d = indent(lines[j] as string)
      if (d < level) {
        keep.add(j)
        level = d
      }
    }
  })
  return { lines: [...keep].sort((a, b) => a - b).map((i) => lines[i] as string), matches }
}

function scrollInfo(snap: PageSnapshot): string {
  const scrollable = snap.scrollH - snap.vh
  if (scrollable <= 8) return ''
  const pct = Math.min(100, Math.max(0, Math.round((snap.scrollY / scrollable) * 100)))
  const screens = Math.max(1, Math.round((snap.scrollH / Math.max(1, snap.vh)) * 10) / 10)
  return ` · scrolled ${pct}% of ${screens} screens`
}

/** Header + lines, capped at `maxTokens` per page, with hints about what was left out. */
export function formatSnapshot(snap: PageSnapshot, options: SnapshotFormatOptions): FormattedSnapshot {
  const maxTokens = Math.max(500, Math.min(MAX_SNAPSHOT_TOKENS, Math.round(options.maxTokens)))
  const header = [
    `Page: ${snap.title || '(untitled)'}`,
    `URL: ${snap.url}`,
    `Viewport ${snap.vw}x${snap.vh}${scrollInfo(snap)}${options.tabs && options.tabs > 1 ? ` · ${options.tabs} tabs` : ''}`,
  ]
  if (snap.focus && (snap.focus.ref || snap.focus.n)) {
    header.push(
      `Focused: ${snap.focus.r}${snap.focus.n ? ` ${quote(snap.focus.n)}` : ''}${snap.focus.ref ? ` [${snap.focus.ref}]` : ''}`,
    )
  }
  let lines = renderTree(snap.tree, options.full || !!options.search)
  const notes: string[] = []
  if (options.search) {
    const found = searchLines(lines, options.search)
    lines = found.lines
    header.push(
      `Search ${quote(options.search)}: ${found.matches} matching line${found.matches === 1 ? '' : 's'}`,
    )
  }
  if (lines.length === 0) lines = [options.search ? '(no matches)' : '(no readable content)']
  const headerTokens = estimateTokens(header.join('\n')) + 40
  const pages: string[][] = [[]]
  let used = 0
  for (const line of lines) {
    const cost = estimateTokens(line) + 1
    const current = pages.at(-1) as string[]
    if (current.length > 0 && used + cost > maxTokens - headerTokens) {
      pages.push([line])
      used = cost
    } else {
      current.push(line)
      used += cost
    }
  }
  const page = Math.max(1, Math.min(pages.length, Math.round(options.page)))
  if (pages.length > 1) {
    notes.push(
      page < pages.length
        ? `Part ${page} of ${pages.length}: call browser_snapshot again with page: ${page + 1} for more${options.search ? '' : ', or use search'}.`
        : `Part ${page} of ${pages.length} (last).`,
    )
  }
  if (!options.full && !options.search && (snap.above > 0 || snap.below > 0)) {
    const where = [
      snap.above > 0 ? `~${snap.above} above` : '',
      snap.below > 0 ? `~${snap.below} below` : '',
    ].filter(Boolean)
    notes.push(
      `Only what is on screen is listed (${where.join(', ')} not shown): search finds anything on the page; browser_scroll to move.`,
    )
  }
  if (snap.behindModal)
    notes.push(
      'A modal dialog is open: the page behind it is not listed (close the dialog first, or use search to read it).',
    )
  if (snap.truncated) notes.push('The page is very large; parts were skipped (use search to find something).')
  const text = [
    ...header,
    '',
    ...(pages[page - 1] as string[]),
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n')
  return { text, tokens: estimateTokens(text), pages: pages.length }
}
