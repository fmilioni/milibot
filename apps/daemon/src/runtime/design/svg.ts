import { DESIGN_LIMITS } from '@milibot/shared'
import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5'

import { completePathData, pathEnd, type Point } from './svg-path'

type Element = DefaultTreeAdapterTypes.Element
type ChildNode = DefaultTreeAdapterTypes.ChildNode

/** Anything else is dropped with its content. */
const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'text',
  'tspan',
])
const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text'])
const TEXT_PARENTS = new Set(['text', 'tspan'])
const ATTRIBUTES = new Set([
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'width',
  'height',
  'offset',
  'viewBox',
  'preserveAspectRatio',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'clip-rule',
  'clip-path',
  'clipPathUnits',
  'stop-color',
  'stop-opacity',
  'transform',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'id',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'letter-spacing',
  'dominant-baseline',
])
/** Set on the root from the frame, never taken from the drawing. */
const ROOT_BOX = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio'])
const LOCAL_URL = /^url\(#[\w-]+\)$/
const MAX_ELEMENTS = 3000
const SVG_NS = 'http://www.w3.org/2000/svg'

interface ViewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface SanitizedSvg {
  svg: string
  viewBox: ViewBox
  /** In viewBox units. */
  last: Point | null
}

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function numbers(value: string | undefined): number[] {
  return (value ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
}

function allowedValue(name: string, value: string): boolean {
  if (value.length > 200_000) return false
  if (/url\(/i.test(value)) return LOCAL_URL.test(value.trim())
  if (name === 'id') return /^[\w-]{1,80}$/.test(value)
  return !/[<>]|expression\s*\(|javascript:/i.test(value)
}

function readViewBox(el: Element, box: { width: number; height: number }): ViewBox {
  const get = (name: string) => el.attrs.find((a) => a.name === name)?.value
  const vb = numbers(get('viewBox'))
  if (vb.length === 4 && vb.every(Number.isFinite) && (vb[2] as number) > 0 && (vb[3] as number) > 0)
    return { x: vb[0] as number, y: vb[1] as number, width: vb[2] as number, height: vb[3] as number }
  const width = Number.parseFloat(get('width') ?? '')
  const height = Number.parseFloat(get('height') ?? '')
  if (width > 0 && height > 0) return { x: 0, y: 0, width, height }
  return { x: 0, y: 0, ...box }
}

/** Transforms ignored. */
function shapeEnd(el: Element): Point | null {
  const get = (name: string) => el.attrs.find((a) => a.name === name)?.value
  const num = (name: string) => Number.parseFloat(get(name) ?? '0') || 0
  switch (el.tagName) {
    case 'path':
      return pathEnd(get('d') ?? '')
    case 'circle':
    case 'ellipse':
      return { x: num('cx'), y: num('cy') }
    case 'rect':
      return { x: num('x') + num('width'), y: num('y') + num('height') }
    case 'line':
      return { x: num('x2'), y: num('y2') }
    case 'polyline':
    case 'polygon': {
      const values = numbers(get('points'))
      const n = values.length - (values.length % 2)
      return n >= 2 ? { x: values[n - 2] as number, y: values[n - 1] as number } : null
    }
    default:
      return null
  }
}

/** Written as XML ourselves: parse5's HTML serializer isn't well-formed, and an `<img>` refuses that. */
export function sanitizeSvg(markup: string, box: { width: number; height: number }): SanitizedSvg | null {
  const root = parseFragment(markup).childNodes.find((n): n is Element => isElement(n) && n.tagName === 'svg')
  if (!root) return null
  const viewBox = readViewBox(root, box)
  let count = 0
  let shapes = 0
  let last: Point | null = null

  const write = (el: Element): string => {
    if (++count > MAX_ELEMENTS) return ''
    const tag = el.tagName
    const attrs = el.attrs.filter(
      (a) =>
        !a.prefix &&
        ATTRIBUTES.has(a.name) &&
        allowedValue(a.name, a.value) &&
        !(tag === 'svg' && ROOT_BOX.has(a.name)),
    )
    if (tag === 'svg') {
      attrs.push(
        { name: 'viewBox', value: `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` },
        { name: 'width', value: String(box.width) },
        { name: 'height', value: String(box.height) },
      )
      const aspect = el.attrs.find((a) => a.name === 'preserveAspectRatio')?.value
      if (aspect && /^[\w\s]{1,40}$/.test(aspect)) attrs.push({ name: 'preserveAspectRatio', value: aspect })
    }
    if (SHAPES.has(tag)) {
      shapes++
      last = shapeEnd(el) ?? last
    }
    const children = el.childNodes
      .map((child) => {
        if (isElement(child)) return ELEMENTS.has(child.tagName) ? write(child) : ''
        if (child.nodeName === '#text' && TEXT_PARENTS.has(tag))
          return escapeText((child as DefaultTreeAdapterTypes.TextNode).value)
        return ''
      })
      .join('')
    const head = `<${tag}${tag === 'svg' ? ` xmlns="${SVG_NS}"` : ''}${attrs.map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`).join('')}`
    return children ? `${head}>${children}</${tag}>` : `${head}/>`
  }

  const svg = write(root)
  if (shapes === 0 || count > MAX_ELEMENTS || Buffer.byteLength(svg) > DESIGN_LIMITS.frameHtmlBytes)
    return null
  return { svg, viewBox, last }
}

export function extractSvg(text: string): string | null {
  const start = text.search(/<svg[\s>]/i)
  if (start < 0) return null
  const end = text.lastIndexOf('</svg>')
  return end > start ? text.slice(start, end + '</svg>'.length) : null
}

/** Frame pixels of a viewBox point, with the default `xMidYMid meet` fit. */
function toFramePoint(point: Point, viewBox: ViewBox, box: { width: number; height: number }): Point {
  const scale = Math.min(box.width / viewBox.width, box.height / viewBox.height)
  return {
    x: Math.round(((point.x - viewBox.x) * scale + (box.width - viewBox.width * scale) / 2) * 10) / 10,
    y: Math.round(((point.y - viewBox.y) * scale + (box.height - viewBox.height * scale) / 2) * 10) / 10,
  }
}

/** A tag cut midway is dropped, except geometry being written, kept to its last whole command so it grows. */
export function partialSvg(
  text: string,
  box: { width: number; height: number },
): { svg: string; pen: Point | null } | null {
  const start = text.search(/<svg[\s>]/i)
  if (start < 0) return null
  let body = text.slice(start)
  const close = body.indexOf('</svg>')
  if (close >= 0) body = body.slice(0, close + '</svg>'.length)
  let growing: Point | null = null
  const lt = body.lastIndexOf('<')
  if (close < 0 && lt > body.lastIndexOf('>')) {
    if (lt === 0) return null
    const tag = body.slice(lt)
    body = body.slice(0, lt)
    const path = /^<path\b[^>]*?\sd\s*=\s*"([^"]*)$/.exec(tag)
    const poly = /^<(polyline|polygon)\b[^>]*?\spoints\s*=\s*"([^"]*)$/.exec(tag)
    if (path) {
      const d = completePathData(path[1] as string)
      if (d) {
        body += `${tag.slice(0, tag.length - (path[1] as string).length)}${d}"/>`
        growing = pathEnd(d)
      }
    } else if (poly) {
      const values = numbers(poly[2]).slice(0, -1)
      const n = values.length - (values.length % 2)
      if (n >= 4) {
        const points = values.slice(0, n).join(' ')
        body += `${tag.slice(0, tag.length - (poly[2] as string).length)}${points}"/>`
        growing = { x: values[n - 2] as number, y: values[n - 1] as number }
      }
    }
  }
  body = body.replace(/&[#\w]*$/, '')
  const sanitized = sanitizeSvg(body, box)
  if (!sanitized) return null
  const at = growing ?? sanitized.last
  return { svg: sanitized.svg, pen: at ? toFramePoint(at, sanitized.viewBox, box) : null }
}
