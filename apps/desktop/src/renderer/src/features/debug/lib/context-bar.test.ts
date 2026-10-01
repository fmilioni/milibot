import { describe, expect, it } from 'vitest'

import { barWidths, compositionSegments } from './context-bar'

describe('context composition bar', () => {
  it('carves persona out of the system prompt and MCP servers out of tools', () => {
    const { total, segments } = compositionSegments({
      systemPrompt: 2100,
      persona: 600,
      tools: 3000,
      mcpServers: { GitHub: 1200, Linear: 5000 },
      longTermMemory: 1400,
      summaries: 2800,
      retrieved: 900,
      recentTail: 10_400,
      images: 2500,
      imageCount: 2,
    })
    expect(segments.map((s) => [s.key, s.tokens])).toEqual([
      ['system', 1500],
      ['persona', 600],
      ['mcp:GitHub', 1200],
      ['mcp:Linear', 1800],
      ['memory', 1400],
      ['summaries', 2800],
      ['retrieved', 900],
      ['tail', 10_400],
      ['images', 2500],
    ])
    expect(total).toBe(2100 + 3000 + 1400 + 2800 + 900 + 10_400 + 2500)
    expect(segments.find((s) => s.kind === 'images')?.count).toBe(2)
    expect(segments.reduce((sum, s) => sum + s.width, 0)).toBeCloseTo(100, 6)
  })

  it('shows Claude Code base and history and skips empty sections', () => {
    const { segments } = compositionSegments({
      base: 10_000,
      systemPrompt: 2000,
      tools: 1900,
      longTermMemory: 0,
      summaries: 0,
      retrieved: 0,
      recentTail: 300,
      history: 5000,
    })
    expect(segments.map((s) => s.kind)).toEqual(['base', 'system', 'tools', 'history', 'tail'])
  })

  it('bar widths add up to exactly 100 and keep tiny sections visible', () => {
    const widths = barWidths([100_000, 10, 0, 50])
    expect(widths[2]).toBe(0)
    expect(widths[1]).toBeGreaterThanOrEqual(1)
    expect(widths[3]).toBeGreaterThanOrEqual(1)
    expect(Math.round(widths.reduce((a, b) => a + b, 0) * 100)).toBe(10_000)
    expect(barWidths([1, 1, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6)
    expect(barWidths([0, 0])).toEqual([0, 0])
    expect(barWidths([5])).toEqual([100])
  })
})
