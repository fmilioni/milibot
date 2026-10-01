import type { ContextComposition } from '@milibot/shared'

type SegmentKind =
  | 'base'
  | 'system'
  | 'persona'
  | 'tools'
  | 'mcp'
  | 'memory'
  | 'summaries'
  | 'retrieved'
  | 'knowledge'
  | 'tail'
  | 'history'
  | 'images'

export interface CompositionSegment {
  /** Unique per segment (`mcp:<server>` for each external MCP server). */
  key: string
  kind: SegmentKind
  /** Server name of an `mcp` segment. */
  name?: string
  /** Images counted in an `images` segment. */
  count?: number
  tokens: number
  color: string
  /** Width in the stacked bar, in percent; the widths of a bar add up to exactly 100. */
  width: number
}

const SEGMENT_COLORS: Record<SegmentKind, string> = {
  base: '#3B82F6',
  system: '#6366F1',
  persona: '#A78BFA',
  tools: '#0EA5E9',
  mcp: '#06B6D4',
  memory: '#8B5CF6',
  summaries: '#EC4899',
  retrieved: '#F59E0B',
  knowledge: '#EAB308',
  tail: '#14B8A6',
  history: '#84CC16',
  images: '#64748B',
}

const MCP_SHADES = ['#06B6D4', '#22D3EE', '#0891B2', '#67E8F9', '#155E75']

/** Smallest width (percent) of a non-empty segment, so tiny sections stay visible. */
const MIN_SEGMENT_WIDTH = 1

/**
 * Splits a composition into bar segments, in the order the context is built (most stable first).
 * `persona` is carved out of `systemPrompt` and each MCP server out of `tools`; both are clamped so
 * a sub-part never exceeds its section.
 */
export function compositionSegments(c: ContextComposition): {
  total: number
  segments: CompositionSegment[]
} {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max))
  const persona = clamp(c.persona ?? 0, c.systemPrompt)
  const servers = Object.entries(c.mcpServers ?? {}).filter(([, tokens]) => tokens > 0)
  let mcpLeft = Math.max(0, c.tools)
  const mcp = servers.map(([name, tokens], i) => {
    const value = clamp(tokens, mcpLeft)
    mcpLeft -= value
    return { name, tokens: value, color: MCP_SHADES[i % MCP_SHADES.length] as string }
  })
  const raw: Array<Omit<CompositionSegment, 'width' | 'color'> & { color?: string }> = [
    { key: 'base', kind: 'base', tokens: c.base ?? 0 },
    { key: 'system', kind: 'system', tokens: c.systemPrompt - persona },
    { key: 'persona', kind: 'persona', tokens: persona },
    { key: 'tools', kind: 'tools', tokens: mcpLeft },
    ...mcp.map((m) => ({
      key: `mcp:${m.name}`,
      kind: 'mcp' as const,
      name: m.name,
      tokens: m.tokens,
      color: m.color,
    })),
    { key: 'memory', kind: 'memory', tokens: c.longTermMemory },
    { key: 'summaries', kind: 'summaries', tokens: c.summaries },
    { key: 'retrieved', kind: 'retrieved', tokens: c.retrieved },
    { key: 'knowledge', kind: 'knowledge', tokens: c.knowledge ?? 0 },
    { key: 'history', kind: 'history', tokens: c.history ?? 0 },
    { key: 'tail', kind: 'tail', tokens: c.recentTail },
    {
      key: 'images',
      kind: 'images',
      tokens: c.images ?? 0,
      ...(c.imageCount ? { count: c.imageCount } : {}),
    },
  ]
  const present = raw.filter((s) => s.tokens > 0)
  const total = present.reduce((sum, s) => sum + s.tokens, 0)
  const widths = barWidths(present.map((s) => s.tokens))
  return {
    total,
    segments: present.map((s, i) => ({
      ...s,
      color: s.color ?? SEGMENT_COLORS[s.kind],
      width: widths[i] as number,
    })),
  }
}

/**
 * Percent widths proportional to `values`, each non-zero value at least `min`, adding up to exactly
 * 100 (two decimals, largest remainder).
 */
export function barWidths(values: number[], min = MIN_SEGMENT_WIDTH): number[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0)
  if (total <= 0) return values.map(() => 0)
  const nonZero = values.filter((v) => v > 0).length
  const floor = Math.min(min, 100 / Math.max(1, nonZero))
  let widths = values.map((v) => (v > 0 ? (v / total) * 100 : 0))
  const small = widths.map((w) => w > 0 && w < floor)
  const reserved = small.filter(Boolean).length * floor
  const rest = widths.reduce((sum, w, i) => (small[i] ? sum : sum + w), 0)
  if (reserved > 0 && rest > 0) {
    widths = widths.map((w, i) => (small[i] ? floor : (w / rest) * (100 - reserved)))
  }
  const cents = widths.map((w) => Math.floor(w * 100))
  let missing = 10_000 - cents.reduce((sum, c) => sum + c, 0)
  const order = widths
    .map((w, i) => ({ i, remainder: w * 100 - Math.floor(w * 100) }))
    .filter(({ i }) => (values[i] ?? 0) > 0)
    .sort((a, b) => b.remainder - a.remainder)
  for (let k = 0; missing > 0 && order.length > 0; k = (k + 1) % order.length, missing--) {
    const target = order[k]?.i as number
    cents[target] = (cents[target] as number) + 1
  }
  return cents.map((c) => c / 100)
}
