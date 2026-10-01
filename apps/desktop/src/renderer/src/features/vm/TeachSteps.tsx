import type { TFunction } from 'i18next'
import { ArrowDown, Keyboard, LoaderCircle, MoveVertical } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatKeys, type TeachStep } from '@/features/vm/lib/teach-recording'
import { useReducedMotion } from '@/features/workspace/use-reduced-motion'
import type { ClickMark } from '@/lib/click-mark'
import { cn } from '@/lib/cn'
import { SectionTitle } from '@/ui/SectionTitle'
import { Tooltip } from '@/ui/Tooltip'

import { Screenshot } from './Screenshot'
import { type TeachSession, useTeachStore } from './teach-store'

function stepTitle(step: TeachStep, t: TFunction): string {
  switch (step.kind) {
    case 'type':
      return t('teach.step.type', { text: step.text ?? '' })
    case 'key':
      return t('teach.step.key', { keys: formatKeys(step.keys ?? '', t('teach.space')) })
    case 'scroll':
      return t('teach.step.scroll', { direction: t(`teach.directions.${step.direction ?? 'down'}`) })
    default:
      return t(`teach.step.${step.kind}`, { x: step.x, y: step.y, toX: step.toX, toY: step.toY })
  }
}

function stepMeta(step: TeachStep, t: TFunction): string {
  switch (step.kind) {
    case 'type':
      return t('teach.meta.type')
    case 'key':
      return (step.amount ?? 1) > 1 ? t('teach.meta.keyRepeat', { count: step.amount }) : t('teach.meta.key')
    case 'scroll':
      return t('teach.meta.scroll', { amount: step.amount ?? 1 })
    default:
      return t(`teach.meta.${step.kind}`)
  }
}

function stepMark(step: TeachStep): ClickMark | null {
  if (step.x === undefined || step.y === undefined) return null
  switch (step.kind) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
      return { kind: step.kind, x: step.x, y: step.y }
    case 'drag':
      return step.toX === undefined || step.toY === undefined
        ? null
        : { kind: 'drag', x: step.x, y: step.y, toX: step.toX, toY: step.toY }
    default:
      return null
  }
}

function StepThumb({ step }: { step: TeachStep }) {
  const { t } = useTranslation()
  const shot = step.screenshot
  if (shot?.status === 'ready')
    return <Screenshot sha={shot.sha} mark={stepMark(step)} className="w-[88px]" />
  return (
    <Tooltip
      content={shot?.status === 'pending' ? t('teach.shotPending') : shot ? t('teach.shotFailed') : null}
    >
      <div className="flex aspect-[1280/800] w-[88px] shrink-0 items-center justify-center rounded-md bg-[linear-gradient(200deg,#1E2A44,#2B1E3A)]">
        {shot?.status === 'pending' ? (
          <LoaderCircle
            size={14}
            className="animate-spin text-screen-fg-secondary motion-reduce:animate-none"
          />
        ) : step.kind === 'type' || step.kind === 'key' ? (
          <Keyboard size={18} className="text-screen-fg-secondary" />
        ) : step.kind === 'scroll' ? (
          <MoveVertical size={18} className="text-screen-fg-secondary" />
        ) : null}
      </div>
    </Tooltip>
  )
}

const NEAR_END_PX = 120

/**
 * Follows new steps while the reader is at the end of the panel; when they scrolled up (e.g. to
 * narrate an older step) it counts the steps they have not seen instead of moving them.
 */
function useFollowSteps(count: number, scroller: RefObject<HTMLDivElement | null>) {
  const reduced = useReducedMotion()
  const nearEnd = useRef(true)
  const previous = useRef(count)
  const [unseen, setUnseen] = useState(0)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX
      if (nearEnd.current) setUnseen(0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scroller])
  useEffect(() => {
    const added = count - previous.current
    previous.current = count
    if (added <= 0) return
    const el = scroller.current
    if (nearEnd.current && el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
    else setUnseen((n) => n + added)
  }, [count, scroller, reduced])
  const jump = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
    setUnseen(0)
  }
  return { unseen, jump }
}

/** "Steps": recorded steps, oldest first (it is a procedure), with a thumbnail and optional narration each. */
export function TeachSteps({
  session,
  scroller,
}: {
  session: TeachSession
  scroller: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation()
  const dispatch = useTeachStore((s) => s.dispatch)
  const steps = session.recording.steps
  const last = steps.at(-1)?.id
  const { unseen, jump } = useFollowSteps(steps.length, scroller)
  return (
    <section className="flex flex-col gap-2" aria-label={t('teach.stepsTitle')}>
      <SectionTitle as="h3">{t('teach.stepsTitle')}</SectionTitle>
      {steps.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('teach.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, i) => (
            <li
              key={step.id}
              className={cn(
                'flex gap-2.5 rounded-lg border border-border p-2',
                step.id === last ? 'bg-accent-soft' : 'bg-surface-2',
              )}
            >
              <StepThumb step={step} />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-xs font-bold text-fg-muted">{i + 1}</span>
                  <span className="truncate text-base font-medium text-fg">{stepTitle(step, t)}</span>
                </div>
                <span className="truncate font-mono text-xs text-fg-muted">{stepMeta(step, t)}</span>
                <input
                  value={step.narration}
                  onChange={(e) => dispatch({ type: 'narrate', stepId: step.id, text: e.target.value })}
                  placeholder={t('teach.narration')}
                  aria-label={t('teach.narration')}
                  className="selectable h-[25px] w-full rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent"
                />
              </div>
            </li>
          ))}
        </ol>
      )}
      {unseen > 0 && (
        <div className="pointer-events-none sticky bottom-2 flex justify-center">
          <button
            type="button"
            onClick={jump}
            className="focus-ring pointer-events-auto flex cursor-pointer items-center gap-1 rounded-full bg-accent px-3 py-1 text-sm font-semibold text-on-accent shadow-md"
          >
            {t('teach.newSteps', { count: unseen })}
            <ArrowDown size={13} />
          </button>
        </div>
      )}
    </section>
  )
}
