import type { Bot, QuestionAnswer, QuestionPayload, UserQuestion } from '@milibot/shared'
import { Check, PencilLine, Sparkles } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import {
  canSubmit,
  type DraftAnswer,
  initialDraft,
  isAnswered,
  keyAction,
  questionDraftReducer,
  toAnswers,
} from '@/features/chat/lib/question-card'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'

export function PendingQuestions({
  payload,
  bot,
  onAnswer,
  onDecline,
}: {
  payload: QuestionPayload
  bot: Bot | undefined
  onAnswer: (answers: QuestionAnswer[]) => Promise<void>
  onDecline: () => Promise<void>
}) {
  const { t } = useTranslation()
  const { questions } = payload
  const reducer = useMemo(() => questionDraftReducer(questions), [questions])
  const [draft, dispatch] = useReducer(reducer, questions, initialDraft)
  const [busy, setBusy] = useState(false)
  const otherInputs = useRef<Array<HTMLInputElement | null>>([])
  const name = bot?.name ?? '…'
  const several = questions.length > 1
  const tab = draft.tab
  const question = questions[tab]
  const answer = draft.answers[tab]
  const last = tab === questions.length - 1

  const focusOther = (index: number) => requestAnimationFrame(() => otherInputs.current[index]?.focus())
  const submit = () => {
    if (busy || !canSubmit(draft)) return
    setBusy(true)
    void onAnswer(toAnswers(draft)).finally(() => setBusy(false))
  }
  const decline = () => {
    if (busy) return
    setBusy(true)
    void onDecline().finally(() => setBusy(false))
  }
  const advance = () => {
    if (!isAnswered(answer)) return
    if (last) submit()
    else dispatch({ type: 'tab', tab: tab + 1 })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || event.metaKey || event.ctrlKey || event.altKey) return
    const typing = event.target instanceof HTMLInputElement
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      if (event.target instanceof HTMLButtonElement && !event.target.dataset.option) return
      event.preventDefault()
      advance()
      return
    }
    if (typing) return
    const action = keyAction(question, tab, event.key)
    if (!action) return
    event.preventDefault()
    dispatch(action)
    if (action.type === 'other' && (!question?.multiSelect || !answer?.otherActive)) focusOther(tab)
  }

  if (!question || !answer) return null
  const otherKey = question.options.length + 1

  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface-2 p-4 outline-none focus-within:border-accent"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-question={payload.requestId}
    >
      <div className="flex items-center gap-2">
        {bot && <BotAvatar avatar={bot.avatar} size={18} animated={false} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
          {t('chat.question.title', { name, count: questions.length })}
        </span>
        {!several && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
            {question.header}
          </span>
        )}
      </div>

      {several && (
        <div
          role="tablist"
          aria-label={t('chat.question.tabs')}
          className="flex flex-wrap items-center gap-1.5"
        >
          {questions.map((q, index) => {
            const current = index === tab
            const done = isAnswered(draft.answers[index])
            return (
              <button
                key={index}
                type="button"
                role="tab"
                aria-selected={current}
                disabled={busy}
                onClick={() => dispatch({ type: 'tab', tab: index })}
                className={cn(
                  'focus-ring flex items-center gap-[5px] rounded-full px-2.5 py-1 text-xs font-semibold',
                  current ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-fg-secondary hover:text-fg',
                )}
              >
                {done && !current && <Check size={12} className="text-success" aria-hidden />}
                {q.header}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <p className="selectable text-md leading-[19px] font-semibold text-fg">{question.question}</p>
        {question.multiSelect && <p className="text-xs text-fg-muted">{t('chat.question.multiHint')}</p>}
      </div>

      <div
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.question}
        className="flex flex-col gap-1.5"
      >
        {question.options.map((option, index) => {
          const selected = answer.selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={selected}
              data-option
              disabled={busy}
              onClick={() => dispatch({ type: 'toggle', question: tab, option: index })}
              className={cn(
                'flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:border-accent',
                selected ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-3/50',
              )}
            >
              <KeyBadge active={selected}>{index + 1}</KeyBadge>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-fg">{option.label}</span>
                  {option.recommended && (
                    <span className="flex items-center gap-1 rounded-full bg-success-soft px-[7px] py-px text-xs font-semibold text-success">
                      <Sparkles size={11} aria-hidden />
                      {t('chat.question.recommended')}
                    </span>
                  )}
                </span>
                {option.description && (
                  <span className="text-sm leading-[16px] text-fg-secondary">{option.description}</span>
                )}
              </span>
              <Mark multi={question.multiSelect} checked={selected} />
            </button>
          )
        })}
        <OtherRow
          question={question}
          answer={answer}
          keyNumber={otherKey}
          disabled={busy}
          inputRef={(el) => {
            otherInputs.current[tab] = el
          }}
          onToggle={() => {
            dispatch({ type: 'other', question: tab })
            if (!question.multiSelect || !answer.otherActive) focusOther(tab)
          }}
          onActivate={() => dispatch({ type: 'other', question: tab, active: true })}
          onText={(text) => dispatch({ type: 'otherText', question: tab, text })}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-fg-muted">
          {several
            ? t('chat.question.step', { current: tab + 1, total: questions.length })
            : t('chat.question.keysHint', { last: otherKey })}
        </span>
        {tab === 0 ? (
          <Button size="sm" disabled={busy} onClick={decline}>
            {t('chat.question.dismiss')}
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => dispatch({ type: 'tab', tab: tab - 1 })}>
            {t('chat.question.back')}
          </Button>
        )}
        {last ? (
          <Button size="sm" variant="primary" disabled={busy || !canSubmit(draft)} onClick={submit}>
            {t('chat.question.send')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={busy || !isAnswered(answer)} onClick={advance}>
            {t('chat.question.next')}
          </Button>
        )}
      </div>
    </div>
  )
}

function OtherRow({
  question,
  answer,
  keyNumber,
  disabled,
  inputRef,
  onToggle,
  onActivate,
  onText,
}: {
  question: UserQuestion
  answer: DraftAnswer
  keyNumber: number
  disabled: boolean
  inputRef: (el: HTMLInputElement | null) => void
  onToggle: () => void
  onActivate: () => void
  onText: (text: string) => void
}) {
  const { t } = useTranslation()
  const active = answer.otherActive
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
        active ? 'border-accent bg-accent-soft' : 'border-border bg-surface',
      )}
    >
      <button
        type="button"
        role={question.multiSelect ? 'checkbox' : 'radio'}
        aria-checked={active}
        aria-label={t('chat.question.otherLabel')}
        data-option
        disabled={disabled}
        onClick={onToggle}
        className="focus-ring flex shrink-0 items-center gap-2.5 rounded-[5px]"
      >
        <KeyBadge active={false}>{keyNumber}</KeyBadge>
        <PencilLine size={14} className="text-fg-muted" aria-hidden />
      </button>
      <input
        ref={inputRef}
        type="text"
        value={answer.other}
        disabled={disabled}
        placeholder={t('chat.question.other')}
        aria-label={t('chat.question.otherLabel')}
        maxLength={2000}
        onClick={() => {
          if (!active) onActivate()
        }}
        onChange={(e) => onText(e.target.value)}
        className="selectable h-5 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-muted"
      />
      {(question.multiSelect || active) && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          disabled={disabled}
          onClick={onToggle}
          className="flex shrink-0"
        >
          <Mark multi={question.multiSelect} checked={active} />
        </button>
      )}
    </div>
  )
}

function KeyBadge({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-xs font-semibold',
        active ? 'bg-accent text-on-accent' : 'bg-surface-3 text-fg-secondary',
      )}
      aria-hidden
    >
      {children}
    </span>
  )
}

function Mark({ multi, checked }: { multi: boolean; checked: boolean }) {
  if (multi) {
    return (
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
          checked ? 'border-accent bg-accent text-on-accent' : 'border-border bg-surface',
        )}
        aria-hidden
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'size-4 shrink-0 rounded-full bg-surface',
        checked ? 'border-[5px] border-accent' : 'border border-border',
      )}
      aria-hidden
    />
  )
}
