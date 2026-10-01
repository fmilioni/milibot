import type { UserQuestion } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  canSubmit,
  followedRecommendation,
  initialDraft,
  isAnswered,
  keyAction,
  type QuestionAction,
  type QuestionDraft,
  questionDraftReducer,
  toAnswers,
} from './question-card'

const single: UserQuestion = {
  header: 'Format',
  question: 'Which format?',
  multiSelect: false,
  options: [{ label: 'Spreadsheet', recommended: true }, { label: 'PDF' }, { label: 'Both' }],
}
const multi: UserQuestion = {
  header: 'Suppliers',
  question: 'Which suppliers?',
  multiSelect: true,
  options: [
    { label: 'Power', recommended: true },
    { label: 'Internet', recommended: true },
    { label: 'Rent' },
  ],
}
const neutral: UserQuestion = {
  header: 'Delivery',
  question: 'Where to?',
  multiSelect: false,
  options: [{ label: 'E-mail' }, { label: 'Group' }],
}

function run(questions: UserQuestion[], actions: QuestionAction[]): QuestionDraft {
  const reduce = questionDraftReducer(questions)
  return actions.reduce(reduce, initialDraft(questions))
}

describe('question card draft', () => {
  it('starts with the recommended options selected', () => {
    const draft = initialDraft([single, multi, neutral])
    expect(draft.answers.map((a) => a.selected)).toEqual([['Spreadsheet'], ['Power', 'Internet'], []])
    expect(canSubmit(draft)).toBe(false)
    expect(canSubmit(initialDraft([single, multi]))).toBe(true)
  })

  it('keeps one choice in single choice and toggles in multiple choice, in option order', () => {
    const draft = run(
      [single, multi],
      [
        { type: 'toggle', question: 0, option: 1 },
        { type: 'toggle', question: 1, option: 0 },
        { type: 'toggle', question: 1, option: 2 },
        { type: 'toggle', question: 1, option: 0 },
      ],
    )
    expect(draft.answers[0]?.selected).toEqual(['PDF'])
    expect(draft.answers[1]?.selected).toEqual(['Power', 'Internet', 'Rent'])
  })

  it('treats "Other answer" as a choice that needs text', () => {
    let draft = run([single], [{ type: 'other', question: 0 }])
    expect(draft.answers[0]).toMatchObject({ selected: [], otherActive: true })
    expect(isAnswered(draft.answers[0])).toBe(false)
    draft = run([single], [{ type: 'otherText', question: 0, text: '  CSV  ' }])
    expect(draft.answers[0]).toMatchObject({ selected: [], otherActive: true })
    expect(toAnswers(draft)).toEqual([{ selected: [], other: 'CSV' }])
    draft = run(
      [single],
      [
        { type: 'otherText', question: 0, text: 'CSV' },
        { type: 'toggle', question: 0, option: 2 },
      ],
    )
    expect(toAnswers(draft)).toEqual([{ selected: ['Both'] }])
  })

  it('adds the free text to the options in multiple choice', () => {
    const draft = run([multi], [{ type: 'otherText', question: 0, text: 'Accountant' }])
    expect(toAnswers(draft)).toEqual([{ selected: ['Power', 'Internet'], other: 'Accountant' }])
    const unchecked = run(
      [multi],
      [
        { type: 'otherText', question: 0, text: 'Accountant' },
        { type: 'other', question: 0 },
      ],
    )
    expect(toAnswers(unchecked)).toEqual([{ selected: ['Power', 'Internet'] }])
  })

  it('maps digits to options and the free text right after them', () => {
    expect(keyAction(single, 0, '2')).toEqual({ type: 'toggle', question: 0, option: 1 })
    expect(keyAction(single, 0, '4')).toEqual({ type: 'other', question: 0 })
    expect(keyAction(single, 0, '5')).toBeNull()
    expect(keyAction(single, 0, '0')).toBeNull()
    expect(keyAction(single, 0, 'a')).toBeNull()
  })

  it('moves between tabs only inside the questions', () => {
    expect(run([single, multi], [{ type: 'tab', tab: 1 }]).tab).toBe(1)
    expect(run([single, multi], [{ type: 'tab', tab: 2 }]).tab).toBe(0)
  })

  it('tells when the user stayed with the recommendation', () => {
    expect(followedRecommendation(single, { selected: ['Spreadsheet'] })).toBe(true)
    expect(followedRecommendation(single, { selected: ['PDF'] })).toBe(false)
    expect(followedRecommendation(multi, { selected: ['Internet', 'Power'] })).toBe(true)
    expect(followedRecommendation(multi, { selected: ['Power'] })).toBe(false)
    expect(followedRecommendation(multi, { selected: ['Power', 'Internet'], other: 'x' })).toBe(false)
    expect(followedRecommendation(neutral, { selected: ['Group'] })).toBe(false)
  })
})
