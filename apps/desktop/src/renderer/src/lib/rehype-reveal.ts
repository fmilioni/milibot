import type { RevealChunk } from './reveal'

interface HastText {
  type: 'text'
  value: string
  position?: { start: { offset?: number }; end: { offset?: number } }
}

interface HastElement {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

interface HastRoot {
  type: 'root'
  children: HastNode[]
}

type HastNode = HastText | HastElement | HastRoot | { type: string }

export interface RevealOptions {
  /** Recently revealed runs (source offsets), each wrapped so it can fade in. */
  chunks: RevealChunk[]
  /** Appends the streaming caret after the last text. */
  caret: boolean
}

const SKIP = new Set(['pre', 'code'])
const CARET_HOSTS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol'])
const INLINE_HOSTS = new Set(['strong', 'em', 'del', 'a'])

function isParent(node: HastNode): node is HastElement | HastRoot {
  return node.type === 'root' || node.type === 'element'
}

function splitText(node: HastText, chunks: RevealChunk[]): HastNode[] {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return [node]
  const pieces: HastNode[] = []
  let cursor = 0
  let born: number | null = null
  const push = (to: number) => {
    if (to <= cursor) return
    const text: HastText = { type: 'text', value: node.value.slice(cursor, to) }
    pieces.push(
      born === null
        ? text
        : {
            type: 'element',
            tagName: 'span',
            properties: { dataRevealBorn: born },
            children: [text],
          },
    )
    cursor = to
  }
  for (const chunk of chunks) {
    if (chunk.start >= end) break
    const at = Math.max(0, Math.min(node.value.length, chunk.start - start))
    push(at)
    born = chunk.born
  }
  push(node.value.length)
  return pieces
}

function wrapChunks(parent: HastElement | HastRoot, chunks: RevealChunk[]): void {
  parent.children = parent.children.flatMap((child) => {
    if (child.type === 'text') return splitText(child as HastText, chunks)
    if (child.type === 'element' && !SKIP.has((child as HastElement).tagName)) {
      wrapChunks(child as HastElement, chunks)
    }
    return [child]
  })
}

function appendCaret(root: HastRoot): void {
  let host: HastElement | HastRoot = root
  for (;;) {
    const last: HastNode | undefined = [...host.children]
      .reverse()
      .find((c) => c.type !== 'text' || (c as HastText).value.trim() !== '')
    if (
      last?.type === 'element' &&
      (CARET_HOSTS.has((last as HastElement).tagName) || INLINE_HOSTS.has((last as HastElement).tagName))
    ) {
      host = last as HastElement
      continue
    }
    break
  }
  host.children.push({
    type: 'element',
    tagName: 'span',
    properties: { className: ['stream-caret'], ariaHidden: 'true' },
    children: [],
  })
}

/**
 * Rehype plugin for the live reveal: wraps text revealed in the last moments in
 * `<span data-reveal-born>` (outside code) and places the caret at the end of the last block.
 */
export function rehypeReveal(options: RevealOptions) {
  return (tree: HastRoot) => {
    if (options.chunks.length > 0 && isParent(tree)) wrapChunks(tree, options.chunks)
    if (options.caret) appendCaret(tree)
  }
}
