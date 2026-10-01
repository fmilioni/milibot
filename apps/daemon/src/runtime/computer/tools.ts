import { setTimeout as sleep } from 'node:timers/promises'

import { pngSize, type ToolExecContext, type ToolResult } from '@milibot/agent'
import type { ContentPart } from '@milibot/agent/llm'
import {
  describeToolCall,
  MAX_COMPUTER_BATCH,
  numberArg,
  optionalString,
  requireString,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type ToolArgs,
  ToolInputError,
  toolText,
} from '@milibot/agent/tools'
import type { Bot, InputAction } from '@milibot/shared'

import type { FileBlobStore } from '../blobs'
import { type ToolHandlers, ToolSwitch } from '../tools-core'
import type { GuestClient, VmController } from '../vm'

function coordinate(a: ToolArgs, key: string, max: number): number {
  const value = a[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ToolInputError(`"${key}" must be a number`)
  const n = Math.round(value)
  if (n < 0 || n > max)
    throw new ToolInputError(`"${key}"=${n} is outside the ${SCREEN_WIDTH}x${SCREEN_HEIGHT} screen`)
  return n
}

function batchItems(a: ToolArgs): ToolArgs[] {
  const items = a.actions
  if (!Array.isArray(items) || items.length === 0)
    throw new ToolInputError('"actions" must be a non-empty array')
  if (items.length > MAX_COMPUTER_BATCH)
    throw new ToolInputError(`at most ${MAX_COMPUTER_BATCH} actions per call`)
  return items.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new ToolInputError(`actions[${i}] must be an object`)
    return item as ToolArgs
  })
}

export interface ComputerToolsDeps {
  vm: Pick<VmController, 'guest'>
  blobs: Pick<FileBlobStore, 'put'>
  /** Delay before the screenshot that follows a GUI action. */
  settleMs?: number
  /** `{{secret:NAME}}` in typed text → the value (throws `SecretRefError` for unknown names). */
  resolveSecretRefs?: (bot: Bot, text: string) => string
}

/** `computer`: screenshots and input on the bot's own display. */
function computerHandlers(deps: ComputerToolsDeps): ToolHandlers {
  const settleMs = deps.settleMs ?? 700

  async function screenshotResult(
    guest: GuestClient,
    bot: Bot,
    note: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const png = await guest.screenshot(bot.displayNum, signal)
    const sha = await deps.blobs.put(png, 'image/png')
    const size = pngSize(png) ?? { width: SCREEN_WIDTH, height: SCREEN_HEIGHT }
    const content: ContentPart[] = [
      { type: 'text', text: note },
      { type: 'image', sha256: sha, mediaType: 'image/png', width: size.width, height: size.height },
    ]
    return { content, screenshotSha: sha }
  }

  function inputAction(bot: Bot, a: ToolArgs): InputAction {
    const action = requireString(a, 'action')
    const x = () => coordinate(a, 'x', SCREEN_WIDTH - 1)
    const y = () => coordinate(a, 'y', SCREEN_HEIGHT - 1)
    switch (action) {
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'move':
        return { type: action, x: x(), y: y() }
      case 'drag':
        return {
          type: 'drag',
          from: { x: x(), y: y() },
          to: { x: coordinate(a, 'to_x', SCREEN_WIDTH - 1), y: coordinate(a, 'to_y', SCREEN_HEIGHT - 1) },
        }
      case 'scroll': {
        const amount = numberArg(a, 'amount', { min: 1, max: 30, fallback: 3, round: true })
        const direction = optionalString(a, 'direction') ?? 'down'
        const delta = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[
          direction
        ]
        if (!delta) throw new ToolInputError('direction must be up, down, left or right')
        return {
          type: 'scroll',
          ...(a.x !== undefined ? { x: x(), y: y() } : {}),
          dx: delta[0] as number,
          dy: delta[1] as number,
        }
      }
      case 'type': {
        const typed = requireString(a, 'text')
        return { type: 'type', text: deps.resolveSecretRefs ? deps.resolveSecretRefs(bot, typed) : typed }
      }
      case 'key':
        return { type: 'key', keys: requireString(a, 'keys') }
      case 'wait': {
        const ms = numberArg(a, 'ms', { min: 0, max: 30_000, fallback: 1000, round: true })
        return { type: 'wait', ms }
      }
      case 'screenshot':
        throw new ToolInputError('"screenshot" cannot be batched; set screenshot_after: true instead')
      default:
        throw new ToolInputError(`unknown action "${action}"`)
    }
  }

  async function computer(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const batch = a.actions !== undefined ? batchItems(a) : null
    if (!batch && requireString(a, 'action') === 'screenshot') {
      return screenshotResult(
        await deps.vm.guest(),
        ctx.bot,
        `Screenshot of your display (${SCREEN_WIDTH}x${SCREEN_HEIGHT}).`,
        ctx.signal,
      )
    }
    const items = batch ?? [a]
    const inputs = items.map((item, i) => {
      try {
        return inputAction(ctx.bot, item)
      } catch (err) {
        if (batch && err instanceof ToolInputError) throw new ToolInputError(`actions[${i}]: ${err.message}`)
        throw err
      }
    })
    const guest = await deps.vm.guest()
    await guest.input(ctx.bot.displayNum, inputs, ctx.signal)
    const describe = (item: ToolArgs) => {
      const step = describeToolCall('computer', item)
      return `${step.kind}${step.detail ? ` ${step.detail}` : ''}`
    }
    const done = batch
      ? `Done, ${items.length} actions: ${items.map(describe).join('; ')}.`
      : `Done: ${describe(a)}.`
    if (a.screenshot_after !== true) return toolText(done)
    if (items.at(-1)?.action !== 'wait') await sleep(settleMs)
    return screenshotResult(guest, ctx.bot, `${done} Current screen:`, ctx.signal)
  }

  return { computer }
}

export class ComputerTools extends ToolSwitch {
  readonly name = 'computer'
  protected readonly handlers: ToolHandlers

  constructor(deps: ComputerToolsDeps) {
    super()
    this.handlers = computerHandlers(deps)
  }
}
