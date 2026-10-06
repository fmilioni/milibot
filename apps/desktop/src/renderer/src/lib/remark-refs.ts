import type { Link, Nodes, Parents, PhrasingContent, Root, Text } from 'mdast'

import { REF_MATCHERS, tokenize } from './linkify'

const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html'])

/** Where `index` characters into `node` sits in the source (what `rehype-reveal` reads to fade text in). */
function shifted(node: Text, from: number, to: number): Text['position'] {
  const position = node.position
  if (!position || position.start.offset === undefined) return undefined
  const at = (index: number) => ({
    line: position.start.line,
    column: position.start.column + index,
    offset: (position.start.offset as number) + index,
  })
  return { start: at(from), end: at(to) }
}

function split(node: Text): PhrasingContent[] | null {
  const tokens = tokenize(node.value, REF_MATCHERS)
  if (tokens.length === 1 && tokens[0]?.type === 'text') return null
  let cursor = 0
  return tokens.map((token) => {
    const from = cursor
    cursor += token.text.length
    const position = shifted(node, from, cursor)
    const text: Text = { type: 'text', value: token.text, ...(position ? { position } : {}) }
    if (token.type === 'text') return text
    const link: Link = { type: 'link', url: token.href, title: null, children: [text] }
    return link
  })
}

function walk(parent: Parents): void {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i] as Nodes
    if (child.type === 'text') {
      const parts = split(child)
      if (!parts) continue
      ;(parent.children as Nodes[]).splice(i, 1, ...parts)
      i += parts.length - 1
    } else if (!SKIP.has(child.type) && 'children' in child) {
      walk(child)
    }
  }
}

/**
 * Turns ids of the app (`bcd_…`) and `/workspace/` file paths in the text into links whose `url` is the id
 * or the path; the `a` renderer decides how they look. Code (inline or block) is not text, so it stays code;
 * text already inside a link is left alone.
 */
export function remarkRefs() {
  return (tree: Root) => walk(tree)
}
