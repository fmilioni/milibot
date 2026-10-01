import type { Language, ProcedureParameter, ProcedureStepKind, RecordedStep } from '@milibot/shared'

import { recordedStepText } from './recorded-steps'

/** Screenshots sent with the recording (the model sees the screen at each click, up to this many). */
const MAX_PROCEDURE_IMAGES = 12

const STEP_KINDS: readonly ProcedureStepKind[] = [
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'other',
]

interface ProcedureDraftStep {
  kind: ProcedureStepKind
  instruction: string
  target: string | null
  value: string | null
  /** 1-based index of the recorded step it comes from. */
  recorded: number | null
}

export interface ProcedureDraft {
  goal: string
  preconditions: string[]
  parameters: ProcedureParameter[]
  steps: ProcedureDraftStep[]
}

/** Recorded step numbers whose screenshot is sent, spread over the whole recording. */
export function pickScreenshotSteps(steps: RecordedStep[], max = MAX_PROCEDURE_IMAGES): number[] {
  const withShot = steps.flatMap((s, i) => (s.screenshotSha ? [i] : []))
  if (withShot.length <= max) return withShot
  const picked = new Set<number>()
  for (let k = 0; k < max; k++)
    picked.add(withShot[Math.round((k * (withShot.length - 1)) / (max - 1))] as number)
  return [...picked].sort((a, b) => a - b)
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function jsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** Parses the model's JSON; null when it is unusable (no goal or no steps). */
export function parseProcedure(text: string, recordedCount: number): ProcedureDraft | null {
  const raw = jsonObject(text) as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') return null
  const goal = trimmedOrNull(raw.goal)
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : []
  const steps = rawSteps.flatMap((item): ProcedureDraftStep[] => {
    if (!item || typeof item !== 'object') return []
    const s = item as Record<string, unknown>
    const instruction = trimmedOrNull(s.instruction)
    if (!instruction) return []
    const recorded =
      typeof s.recorded === 'number' &&
      Number.isInteger(s.recorded) &&
      s.recorded >= 1 &&
      s.recorded <= recordedCount
        ? s.recorded
        : null
    const kind = STEP_KINDS.includes(s.kind as ProcedureStepKind) ? (s.kind as ProcedureStepKind) : 'other'
    return [{ kind, instruction, target: trimmedOrNull(s.target), value: trimmedOrNull(s.value), recorded }]
  })
  if (!goal || steps.length === 0) return null
  const preconditions = (Array.isArray(raw.preconditions) ? raw.preconditions : []).flatMap(
    (p) => trimmedOrNull(p) ?? [],
  )
  const parameters = (Array.isArray(raw.parameters) ? raw.parameters : []).flatMap(
    (p): ProcedureParameter[] => {
      if (!p || typeof p !== 'object') return []
      const o = p as Record<string, unknown>
      const name = trimmedOrNull(o.name)?.replace(/[{}\s]/g, '')
      if (!name) return []
      return [{ name, description: trimmedOrNull(o.description) ?? '', example: trimmedOrNull(o.example) }]
    },
  )
  return { goal, preconditions, parameters, steps }
}

/** The recording as is, when the model is unavailable or its answer is unusable. */
export function fallbackProcedure(
  name: string,
  steps: RecordedStep[],
  language: Language = 'en',
): ProcedureDraft {
  return {
    goal: name,
    preconditions: [],
    parameters: [],
    steps: steps.map((step, i) => ({
      kind: step.kind,
      instruction: recordedStepText(step, language),
      target: null,
      value: step.kind === 'type' ? (step.text ?? null) : step.kind === 'key' ? (step.keys ?? null) : null,
      recorded: i + 1,
    })),
  }
}

/** File name of a taught step's screenshot, as `skill_read` serves it. */
export function procedureStepImage(position: number): string {
  return `step-${position}.png`
}
