import type { Language, Procedure, RecordedStep } from '@milibot/shared'

import { procedureStepImage } from '../procedures/procedure'
import { recordedStepText } from '../procedures/recorded-steps'
import { LANGUAGE_NAMES } from './language'

export const PROCEDURE_SYSTEM_PROMPT = `You turn a recording of a user operating a Linux desktop (XFCE, 1280x800) into a reusable procedure that an AI agent will follow later on its own desktop, where windows, positions and data may differ.

You receive the procedure name and the recorded steps: clicks with screen coordinates (and a screenshot taken at the click, with a red ring on the clicked point), typed text, key shortcuts, scrolls and optional narration by the user. Write the procedure so it survives layout changes:
- goal: one sentence with what the procedure achieves.
- preconditions: what must be true or open before starting (apps, files, logins); empty if none.
- steps: one per meaningful action, in order. "instruction" says what to do in the imperative; "target" describes what to click or type into by its visible label, icon, window and region (never by coordinates only); "value" is the text typed or the keys pressed. Merge mechanical noise (e.g. a click that only focused a field right before typing into it can be one step). Keep every step that changes something. Set "recorded" to the number of the recorded step it comes from (null when it merges none).
- parameters: typed values that change on every run (file names, dates, amounts, recipients) become placeholders like {{file_name}} inside "value"; list each with a description and the recorded example. Constant values (menu text, fixed commands) stay literal.
- Use the user's narration: it explains intent and rules ("always export as PDF before sending").

Write in LANGUAGE. Reply with JSON only, no prose and no code fence:
{"goal": "...", "preconditions": ["..."], "parameters": [{"name": "file_name", "description": "...", "example": "..."}], "steps": [{"recorded": 1, "kind": "click", "instruction": "...", "target": "...", "value": null}]}
"kind" is one of: click, double_click, right_click, middle_click, drag, scroll, type, key, other.`

function quote(text: string): string {
  return JSON.stringify(text)
}

export function buildProcedurePrompt(input: {
  name: string
  botName: string
  steps: RecordedStep[]
  language: Language
  /** Recorded step indexes (0-based) whose screenshot follows the prompt, in this order. */
  screenshots: number[]
}): { system: string; prompt: string } {
  const shots = new Set(input.screenshots)
  const lines = input.steps.map((step, i) => {
    const narration = step.narration?.trim() ? ` — user's note: ${quote(step.narration.trim())}` : ''
    const shot = shots.has(i) ? ` [screenshot ${input.screenshots.indexOf(i) + 1}]` : ''
    return `${i + 1}. ${recordedStepText(step, 'en')}${shot}${narration}`
  })
  const prompt = [
    `Procedure name: ${quote(input.name)}`,
    `Recorded on the desktop of ${input.botName}. ${input.steps.length} steps:`,
    ...lines,
    input.screenshots.length
      ? `The ${input.screenshots.length} screenshots below are in the order of the [screenshot N] marks.`
      : 'No screenshots were captured.',
  ].join('\n')
  return {
    system: PROCEDURE_SYSTEM_PROMPT.replace('LANGUAGE', LANGUAGE_NAMES[input.language]),
    prompt,
  }
}

/** What `skill_load` returns to a bot for a taught procedure. */
export function formatProcedure(procedure: Procedure): string {
  const lines = [`# Skill: ${procedure.name}`, `Goal: ${procedure.goal}`]
  if (procedure.preconditions.length) {
    lines.push('', 'Before starting:', ...procedure.preconditions.map((p) => `- ${p}`))
  }
  if (procedure.parameters.length) {
    lines.push(
      '',
      'Parameters (replace the {{placeholders}} with the values of the current task):',
      ...procedure.parameters.map(
        (p) => `- {{${p.name}}}: ${p.description}${p.example ? ` (when taught: ${quote(p.example)})` : ''}`,
      ),
    )
  }
  lines.push('', 'Steps:')
  for (const [i, step] of procedure.steps.entries()) {
    const parts = [`${i + 1}. ${step.instruction}`]
    if (step.target) parts.push(`   Target: ${step.target}`)
    if (step.value) parts.push(`   ${step.kind === 'key' ? 'Keys' : 'Text'}: ${step.value}`)
    if (step.x !== null && step.y !== null)
      parts.push(`   When taught it was at (${step.x}, ${step.y}); find it again on the current screen.`)
    if (step.narration) parts.push(`   User's note: ${step.narration}`)
    if (step.screenshotSha) parts.push(`   Screenshot: ${procedureStepImage(i + 1)}`)
    lines.push(...parts)
  }
  lines.push(
    '',
    'Follow the steps on your own desktop, checking the screen at the points that matter; positions and data may differ from when it was taught. To see how a step looked, read its screenshot with skill_read.',
  )
  return lines.join('\n')
}
