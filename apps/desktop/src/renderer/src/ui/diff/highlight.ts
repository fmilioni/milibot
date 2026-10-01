import { refractor } from 'refractor'
import dart from 'refractor/dart'
import docker from 'refractor/docker'
import elixir from 'refractor/elixir'
import graphql from 'refractor/graphql'
import jsx from 'refractor/jsx'
import protobuf from 'refractor/protobuf'
import scala from 'refractor/scala'
import toml from 'refractor/toml'
import tsx from 'refractor/tsx'

for (const syntax of [jsx, tsx, toml, docker, dart, elixir, scala, graphql, protobuf])
  refractor.register(syntax)

/** A run of text and the Prism token classes it sits in (empty: plain text). */
export interface Segment {
  text: string
  className: string
}

interface HastLike {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastLike[]
}

function flatten(node: HastLike, classes: string, out: Segment[]): void {
  if (node.type === 'text') {
    if (node.value) out.push({ text: node.value, className: classes })
    return
  }
  const own = node.properties?.className
  const next = Array.isArray(own) ? [classes, ...own.filter((c) => c !== 'token')].join(' ').trim() : classes
  for (const child of node.children ?? []) flatten(child, next, out)
}

/** Highlighted runs of one line of code, or null when the language is unknown (shown as plain text). */
export function highlightLine(text: string, language: string | undefined): Segment[] | null {
  if (!language || !text || !refractor.registered(language)) return null
  try {
    const out: Segment[] = []
    flatten(refractor.highlight(text, language) as HastLike, '', out)
    return out
  } catch {
    return null
  }
}
