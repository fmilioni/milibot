import { type Procedure, type RecordedStep } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { FakeProvider } from '../llm/fake'
import { complete } from '../llm/provider'
import { decodePng, encodePng, solidPng } from '../media/png'
import { buildProcedurePrompt, formatProcedure } from '../prompts/procedures'
import { markClick } from './click-marker'
import { fallbackProcedure, parseProcedure, pickScreenshotSteps } from './procedure'
import { recordedStepText } from './recorded-steps'

const recording: RecordedStep[] = [
  { kind: 'click', at: 1, x: 148, y: 92, screenshotSha: 'a'.repeat(64) },
  {
    kind: 'click',
    at: 2,
    x: 212,
    y: 318,
    screenshotSha: 'b'.repeat(64),
    narration: 'Always export as PDF',
  },
  { kind: 'type', at: 3, text: 'report-2026-09' },
  { kind: 'key', at: 4, keys: 'ctrl+s' },
]

const modelAnswer = JSON.stringify({
  goal: 'Export the open report in Calc as PDF',
  preconditions: ['The report is open in LibreOffice Calc'],
  parameters: [{ name: '{{file_name}}', description: 'File name', example: 'report-2026-09' }],
  steps: [
    {
      recorded: 1,
      kind: 'click',
      instruction: 'Open the File menu',
      target: 'Calc "File" menu',
      value: null,
    },
    {
      recorded: 2,
      kind: 'click',
      instruction: 'Click Export as PDF',
      target: '"Export as PDF" item',
    },
    { recorded: 3, kind: 'type', instruction: 'Type the file name', value: '{{file_name}}' },
    { recorded: 99, kind: 'bogus', instruction: 'Save with Ctrl+S', value: 'ctrl+s' },
    { instruction: '' },
  ],
})

describe('procedure prompt', () => {
  it('lists every recorded step with coordinates, text, keys, narration and screenshot marks', () => {
    const { system, prompt } = buildProcedurePrompt({
      name: 'Export report as PDF',
      botName: 'Analyst',
      steps: recording,
      language: 'pt-BR',
      screenshots: [0, 1],
    })
    expect(system).toContain('Brazilian Portuguese')
    expect(system).not.toContain('LANGUAGE')
    expect(prompt).toContain('Procedure name: "Export report as PDF"')
    expect(prompt).toContain('1. Left click at (148, 92) [screenshot 1]')
    expect(prompt).toContain(
      `2. Left click at (212, 318) [screenshot 2] — user's note: "Always export as PDF"`,
    )
    expect(prompt).toContain('3. Type "report-2026-09"')
    expect(prompt).toContain('4. Press ctrl+s')
  })

  it('describes drags and scrolls', () => {
    expect(recordedStepText({ kind: 'drag', at: 0, x: 1, y: 2, toX: 3, toY: 4 }, 'en')).toBe(
      'Drag from (1, 2) to (3, 4)',
    )
    expect(recordedStepText({ kind: 'scroll', at: 0, x: 5, y: 6, direction: 'up', amount: 3 }, 'en')).toBe(
      'Scroll up 3× at (5, 6)',
    )
  })

  it('spreads the screenshots over the recording when there are too many', () => {
    const many = Array.from({ length: 30 }, (_, i): RecordedStep => ({
      kind: 'click',
      at: i,
      screenshotSha: `s${i}`,
    }))
    const picked = pickScreenshotSteps(many, 4)
    expect(picked).toEqual([0, 10, 19, 29])
    expect(pickScreenshotSteps(recording)).toEqual([0, 1])
  })
})

describe('procedure parsing', () => {
  it('parses the model answer, cleaning parameters, kinds and out-of-range step refs', () => {
    const procedure = parseProcedure(modelAnswer, recording.length)
    expect(procedure?.goal).toBe('Export the open report in Calc as PDF')
    expect(procedure?.parameters).toEqual([
      { name: 'file_name', description: 'File name', example: 'report-2026-09' },
    ])
    expect(procedure?.steps).toHaveLength(4)
    expect(procedure?.steps[2]).toMatchObject({
      kind: 'type',
      value: '{{file_name}}',
      recorded: 3,
      target: null,
    })
    expect(procedure?.steps[3]).toMatchObject({ kind: 'other', recorded: null })
  })

  it('accepts fenced or surrounded JSON and rejects unusable answers', () => {
    expect(parseProcedure('```json\n' + modelAnswer + '\n```', 4)?.steps).toHaveLength(4)
    expect(parseProcedure('Here it is: ' + modelAnswer + ' done', 4)?.goal).toContain('PDF')
    expect(parseProcedure('no json here', 4)).toBeNull()
    expect(parseProcedure(JSON.stringify({ goal: 'x', steps: [] }), 4)).toBeNull()
  })

  it('works end to end with a scripted model', async () => {
    const provider = new FakeProvider({ script: [{ text: modelAnswer }] })
    const { system, prompt } = buildProcedurePrompt({
      name: 'Export',
      botName: 'Analyst',
      steps: recording,
      language: 'en',
      screenshots: [],
    })
    const result = await complete(provider, {
      model: 'fake',
      messages: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
      tools: [],
      blobs: { read: async () => new Uint8Array() },
    })
    const text = result.message.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    expect(parseProcedure(text, recording.length)?.steps.map((s) => s.recorded)).toEqual([1, 2, 3, null])
  })

  it('falls back to the plain recording', () => {
    const procedure = fallbackProcedure('Export', recording)
    expect(procedure.goal).toBe('Export')
    expect(procedure.steps.map((s) => s.recorded)).toEqual([1, 2, 3, 4])
    expect(procedure.steps[1]?.instruction).toBe('Left click at (212, 318)')
    expect(fallbackProcedure('Export', recording, 'pt-BR').steps.map((s) => s.instruction)).toEqual([
      'Clique em (148, 92)',
      'Clique em (212, 318)',
      'Digite "report-2026-09"',
      'Pressione ctrl+s',
    ])
    expect(procedure.steps[2]?.value).toBe('report-2026-09')
    expect(procedure.steps[3]?.value).toBe('ctrl+s')
  })
})

describe('formatProcedure', () => {
  it('renders what skill_load returns for a taught procedure', () => {
    const procedure: Procedure = {
      id: 'skl_1',
      botId: 'bot_1',
      scope: 'bot',
      taughtByBotId: 'bot_1',
      name: 'Export report as PDF',
      goal: 'Export the report as PDF',
      preconditions: ['Calc open'],
      parameters: [{ name: 'file_name', description: 'File name', example: 'report' }],
      status: 'ready',
      error: null,
      createdAt: 0,
      updatedAt: 0,
      steps: [
        {
          id: 's1',
          position: 1,
          kind: 'click',
          instruction: 'Open the File menu',
          target: '"File" menu',
          value: null,
          x: 148,
          y: 92,
          narration: null,
          screenshotSha: 'a'.repeat(64),
        },
        {
          id: 's2',
          position: 2,
          kind: 'type',
          instruction: 'Type the name',
          target: null,
          value: '{{file_name}}',
          x: null,
          y: null,
          narration: 'no extension',
          screenshotSha: null,
        },
      ],
    }
    const text = formatProcedure(procedure)
    expect(text).toContain('# Skill: Export report as PDF')
    expect(text).toContain('- Calc open')
    expect(text).toContain('- {{file_name}}: File name (when taught: "report")')
    expect(text).toContain(
      '1. Open the File menu\n   Target: "File" menu\n   When taught it was at (148, 92)',
    )
    expect(text).toContain("2. Type the name\n   Text: {{file_name}}\n   User's note: no extension")
    expect(text).toContain('Screenshot: step-1.png')
    expect(text).toContain('skill_read')
  })
})

describe('click marker', () => {
  it('round-trips PNGs and rings the clicked point, keeping its center', () => {
    const png = solidPng(64, 48, [10, 20, 30])
    const decoded = decodePng(png)
    expect(decoded).toMatchObject({ width: 64, height: 48 })
    expect(decodePng(encodePng(decoded!))?.pixels).toEqual(decoded?.pixels)

    const marked = decodePng(markClick(png, 32, 24)!)!
    const at = (x: number, y: number) => [...marked.pixels.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)]
    expect(at(32, 24)).toEqual([10, 20, 30])
    expect(at(32 + 16, 24)).toEqual([229, 72, 77])
    expect(at(0, 0)).toEqual([10, 20, 30])
  })

  it('gives up on formats it does not decode', () => {
    expect(markClick(new Uint8Array([1, 2, 3]), 1, 1)).toBeNull()
  })
})
