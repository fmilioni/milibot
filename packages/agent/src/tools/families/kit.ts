import { secretRefRegex } from '@milibot/shared'

import type { ToolDefinition } from '../../llm/provider'
import type { ToolArgs } from '../args'

/** An activity step: a stable `kind` (icon and i18n key) and a short human detail. */
export interface ToolStep {
  kind: string
  detail: string
}

/** How much detail a step shows: one clipped line, or the whole text for expanded views. */
export interface StepView {
  full: boolean
  clip(text: string, max?: number): string
  /** See `DescribeOptions.botName`. */
  botName?: ((ref: string) => string | null | undefined) | undefined
}

export interface ToolFamilySpec<D extends Record<string, ToolDefinition>> {
  definitions: D
  /** The call's activity step; never raw arguments (ids and payloads mean nothing to the user). */
  describe(name: keyof D & string, args: ToolArgs, view: StepView): ToolStep
  /** Plain-text labels of the step kinds `describe` returns; a kind without one shows as its words. */
  labels?: Readonly<Record<string, string>>
}

export interface ToolFamilyModule<D extends Record<string, ToolDefinition>> extends ToolFamilySpec<D> {
  names: ReadonlyArray<keyof D & string>
  has(name: string): name is keyof D & string
  labels: Readonly<Record<string, string>>
}

export function defineTools<D extends Record<string, ToolDefinition>>(
  spec: ToolFamilySpec<D>,
): ToolFamilyModule<D> {
  const names = Object.keys(spec.definitions) as Array<keyof D & string>
  return {
    ...spec,
    labels: spec.labels ?? {},
    names,
    has: (name: string): name is keyof D & string => Object.hasOwn(spec.definitions, name),
  }
}

/** Scalar argument as text; objects and arrays are never shown raw. */
export function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

/** Typed text as shown to the user: a `{{secret:NAME}}` reference becomes `•••• (NAME)`, never raw. */
export function describeSecretRefs(text: string): string {
  return text.replace(secretRefRegex(), (_, name: string) => `•••• (${name})`)
}

export function shortUrl(url: string, view: StepView): string {
  return view.clip(url.replace(/^https?:\/\//i, '').replace(/\/$/, ''), 60)
}

/** Something the bot named by id or by name: ids mean nothing to the user (the tool result names it). */
export function namedRef(ref: string, idPattern: RegExp, view: StepView): string {
  return idPattern.test(ref) ? '' : view.clip(ref, 60)
}
