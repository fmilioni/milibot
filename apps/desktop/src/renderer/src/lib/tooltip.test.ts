import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeTooltipPosition, TooltipController, type TooltipTimers, type TooltipWarmth } from './tooltip'

const viewport = { width: 1000, height: 700 }
const tip = { width: 120, height: 30 }
const box = (left: number, top: number, width = 32, height = 32) => ({ left, top, width, height })

describe('computeTooltipPosition', () => {
  it('prefers the top, centered on the anchor', () => {
    expect(computeTooltipPosition(box(484, 300), tip, viewport)).toEqual({ side: 'top', left: 440, top: 264 })
  })

  it('flips to the bottom near the top edge', () => {
    expect(computeTooltipPosition(box(484, 10), tip, viewport)).toEqual({
      side: 'bottom',
      left: 440,
      top: 48,
    })
  })

  it('goes sideways when neither top nor bottom fits', () => {
    const tall = { width: 120, height: 330 }
    expect(computeTooltipPosition(box(100, 330, 32, 40), tall, viewport).side).toBe('right')
    expect(computeTooltipPosition(box(900, 330, 32, 40), tall, viewport).side).toBe('left')
  })

  it('keeps the preferred side order for left/right preferences', () => {
    expect(computeTooltipPosition(box(500, 300), tip, viewport, 'left').side).toBe('left')
    expect(computeTooltipPosition(box(60, 300), tip, viewport, 'left').side).toBe('right')
  })

  it('clamps inside the viewport margins', () => {
    const atLeft = computeTooltipPosition(box(0, 300, 20, 20), tip, viewport)
    expect(atLeft.left).toBe(8)
    const atRight = computeTooltipPosition(box(990, 300, 10, 20), tip, viewport)
    expect(atRight.left).toBe(1000 - 120 - 8)
  })

  it('picks the roomiest side when nothing fits', () => {
    const huge = { width: 600, height: 690 }
    expect(computeTooltipPosition(box(500, 650, 20, 20), huge, viewport)).toEqual({
      side: 'top',
      left: 210,
      top: 8,
    })
  })
})

describe('TooltipController', () => {
  let clock: number
  let changes: boolean[]
  let warmth: TooltipWarmth
  let controller: TooltipController

  beforeEach(() => {
    vi.useFakeTimers()
    clock = 10_000
    changes = []
    warmth = { lastClosedAt: -Infinity }
    const timers: TooltipTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      now: () => clock,
    }
    controller = new TooltipController((open) => changes.push(open), { delay: 120, timers, warmth })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens after the hover delay and closes on leave', () => {
    controller.pointerEnter()
    vi.advanceTimersByTime(119)
    expect(controller.open).toBe(false)
    vi.advanceTimersByTime(1)
    expect(controller.open).toBe(true)
    controller.pointerLeave()
    expect(changes).toEqual([true, false])
  })

  it('does not open when the pointer leaves before the delay', () => {
    controller.pointerEnter()
    vi.advanceTimersByTime(80)
    controller.pointerLeave()
    vi.advanceTimersByTime(500)
    expect(changes).toEqual([])
  })

  it('opens at once on keyboard focus but not on mouse focus', () => {
    controller.focus(false)
    expect(controller.open).toBe(false)
    controller.focus(true)
    expect(controller.open).toBe(true)
    controller.blur()
    expect(controller.open).toBe(false)
  })

  it('stays open on leave while focused', () => {
    controller.focus(true)
    controller.pointerEnter()
    controller.pointerLeave()
    expect(controller.open).toBe(true)
  })

  it('stays closed after Escape until the pointer leaves', () => {
    controller.pointerEnter()
    vi.advanceTimersByTime(120)
    controller.dismiss()
    expect(controller.open).toBe(false)
    controller.pointerEnter()
    vi.advanceTimersByTime(500)
    expect(controller.open).toBe(false)
    controller.pointerLeave()
    clock += 1_000
    controller.pointerEnter()
    vi.advanceTimersByTime(120)
    expect(controller.open).toBe(true)
  })

  it('a click (dismiss) cancels a pending open', () => {
    controller.pointerEnter()
    controller.dismiss()
    vi.advanceTimersByTime(500)
    expect(changes).toEqual([])
  })

  it('skips the delay right after another tooltip closed', () => {
    controller.focus(true)
    controller.blur()
    clock += 200
    controller.pointerEnter()
    expect(controller.open).toBe(true)
  })

  it('reset forgets a dismissal', () => {
    controller.pointerEnter()
    controller.dismiss()
    controller.reset()
    clock += 1_000
    controller.pointerEnter()
    vi.advanceTimersByTime(120)
    expect(controller.open).toBe(true)
  })
})
