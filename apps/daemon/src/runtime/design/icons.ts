import { icons } from 'lucide'

type IconNode = Array<[string, Record<string, string | number | undefined>]>

let byName: Map<string, IconNode> | null = null

function key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function lookup(): Map<string, IconNode> {
  if (!byName) {
    byName = new Map()
    for (const [name, node] of Object.entries(icons as Record<string, IconNode>)) byName.set(key(name), node)
  }
  return byName
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** `lucide:arrow-right`, `arrow-right` or `ArrowRight` → the icon's name for lookups; null for other sets. */
function iconName(ref: string): string | null {
  const [set, name] = ref.includes(':') ? ref.split(':', 2) : ['lucide', ref]
  if (set?.trim().toLowerCase() !== 'lucide' || !name?.trim()) return null
  return name.trim()
}

/** Inline SVG of a Lucide icon (24×24 by default; classes/styles of the placeholder element are kept). */
export function iconSvg(ref: string, attrs: ReadonlyArray<{ name: string; value: string }>): string | null {
  const name = iconName(ref)
  const node = name ? lookup().get(key(name)) : undefined
  if (!node) return null
  const own = attrs.filter((a) => a.name !== 'data-icon')
  const extra = own.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('')
  const children = node
    .map(
      ([tag, props]) =>
        `<${tag}${Object.entries(props)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
          .join('')}/>`,
    )
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `data-icon="lucide:${escapeAttr(name as string)}"${extra}>${children}</svg>`
  )
}
