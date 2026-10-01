import type { QuestionAnswer, UserQuestion } from '@milibot/shared'

/** What the user picked for one question while the card is open. */
export interface DraftAnswer {
  selected: string[]
  otherActive: boolean
  other: string
}

export interface QuestionDraft {
  tab: number
  answers: DraftAnswer[]
}

export type QuestionAction =
  | { type: 'toggle'; question: number; option: number }
  | { type: 'other'; question: number; active?: boolean }
  | { type: 'otherText'; question: number; text: string }
  | { type: 'tab'; tab: number }
  | { type: 'reset'; questions: UserQuestion[] }

function recommendedLabels(question: UserQuestion): string[] {
  const labels = question.options.filter((o) => o.recommended).map((o) => o.label)
  return question.multiSelect ? labels : labels.slice(0, 1)
}

/** Recommended options start selected, so Enter accepts them. */
export function initialDraft(questions: UserQuestion[]): QuestionDraft {
  return {
    tab: 0,
    answers: questions.map((q) => ({ selected: recommendedLabels(q), otherActive: false, other: '' })),
  }
}

function updateAnswer(
  draft: QuestionDraft,
  index: number,
  update: (answer: DraftAnswer) => DraftAnswer,
): QuestionDraft {
  const answer = draft.answers[index]
  if (!answer) return draft
  return { ...draft, answers: draft.answers.map((a, i) => (i === index ? update(a) : a)) }
}

export function questionDraftReducer(
  questions: UserQuestion[],
): (draft: QuestionDraft, action: QuestionAction) => QuestionDraft {
  return (draft, action) => {
    switch (action.type) {
      case 'reset':
        return initialDraft(action.questions)
      case 'tab':
        return action.tab >= 0 && action.tab < draft.answers.length ? { ...draft, tab: action.tab } : draft
      case 'toggle': {
        const question = questions[action.question]
        const label = question?.options[action.option]?.label
        if (!question || label === undefined) return draft
        return updateAnswer(draft, action.question, (a) =>
          question.multiSelect
            ? {
                ...a,
                selected: a.selected.includes(label)
                  ? a.selected.filter((l) => l !== label)
                  : question.options.map((o) => o.label).filter((l) => l === label || a.selected.includes(l)),
              }
            : { ...a, selected: [label], otherActive: false },
        )
      }
      case 'other': {
        const question = questions[action.question]
        if (!question) return draft
        return updateAnswer(draft, action.question, (a) => {
          const active = action.active ?? (question.multiSelect ? !a.otherActive : true)
          return question.multiSelect || !active
            ? { ...a, otherActive: active }
            : { ...a, otherActive: true, selected: [] }
        })
      }
      case 'otherText': {
        const question = questions[action.question]
        if (!question) return draft
        return updateAnswer(draft, action.question, (a) => ({
          ...a,
          other: action.text,
          otherActive: a.otherActive || action.text.trim().length > 0,
          selected: question.multiSelect || !action.text.trim() ? a.selected : [],
        }))
      }
    }
  }
}

export function isAnswered(answer: DraftAnswer | undefined): boolean {
  if (!answer) return false
  return answer.selected.length > 0 || (answer.otherActive && answer.other.trim().length > 0)
}

export function canSubmit(draft: QuestionDraft): boolean {
  return draft.answers.length > 0 && draft.answers.every(isAnswered)
}

export function toAnswers(draft: QuestionDraft): QuestionAnswer[] {
  return draft.answers.map((a) => {
    const other = a.otherActive ? a.other.trim() : ''
    return other ? { selected: a.selected, other } : { selected: a.selected }
  })
}

/**
 * Keys 1–9 of the open question: an option, or "Other answer" (chat.question.otherLabel) right after the last option.
 * Null when the digit does not map to anything.
 */
export function keyAction(
  question: UserQuestion | undefined,
  questionIndex: number,
  key: string,
): QuestionAction | null {
  if (!question || !/^[1-9]$/.test(key)) return null
  const n = Number(key) - 1
  if (n < question.options.length) return { type: 'toggle', question: questionIndex, option: n }
  if (n === question.options.length) return { type: 'other', question: questionIndex }
  return null
}

/** The user stayed with exactly what the bot recommended (and wrote nothing else). */
export function followedRecommendation(question: UserQuestion, answer: QuestionAnswer | undefined): boolean {
  if (!answer || answer.other?.trim()) return false
  const recommended = recommendedLabels(question)
  if (recommended.length === 0) return false
  return (
    recommended.length === answer.selected.length && recommended.every((l) => answer.selected.includes(l))
  )
}
