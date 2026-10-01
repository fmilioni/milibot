import type { SkillImportCandidate, SkillImportCommitResult } from '@milibot/shared'
import { Info, RefreshCw, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { shortPath } from '@/features/skills/lib/skills'
import { cn } from '@/lib/cn'
import { Checkbox } from '@/ui/Checkbox'
import { Tag } from '@/ui/Tag'

import { type useSkillError } from './SkillParts'

export function CandidateRow({
  candidate,
  first,
  checked,
  onToggle,
  builtinName,
  failure,
  errorText,
}: {
  candidate: SkillImportCandidate
  first: boolean
  checked: boolean
  onToggle: () => void
  builtinName: string
  failure: SkillImportCommitResult['failed'][number] | null
  errorText: ReturnType<typeof useSkillError>
}) {
  const { t } = useTranslation()
  const disabled = candidate.error !== null
  const on = checked && !disabled
  return (
    <li className={first ? '' : 'border-t border-border'}>
      <label
        className={cn(
          'flex items-start gap-3 px-3 py-2.5',
          on && 'bg-accent-soft',
          disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-surface-3/40',
        )}
      >
        <span className="mt-px flex">
          <Checkbox checked={on} disabled={disabled} onChange={onToggle} label={candidate.name} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base font-semibold text-fg">{candidate.name}</span>
            <span className="min-w-0 truncate text-xs text-fg-muted">{shortPath(candidate.path)}</span>
            {candidate.hasScripts && (
              <Tag icon={<Terminal size={11} aria-hidden />}>{t('skills.meta.scripts')}</Tag>
            )}
            {candidate.conflict === 'update' && (
              <Tag tone="accent" icon={<RefreshCw size={11} aria-hidden />}>
                {t('skills.import.conflicts.update')}
              </Tag>
            )}
            {candidate.conflict === 'name_taken' && (
              <Tag icon={<Info size={11} aria-hidden />}>
                {t('skills.import.conflicts.nameTaken', { name: candidate.importAs })}
              </Tag>
            )}
            {candidate.conflict === 'similar_builtin' && (
              <Tag icon={<Info size={11} aria-hidden />}>
                {t('skills.import.conflicts.similarBuiltin', { name: builtinName })}
              </Tag>
            )}
          </span>
          {candidate.error || failure ? (
            <span className="text-sm text-danger">
              {candidate.error
                ? errorText(candidate.error, candidate.errorCode, candidate.errorParams)
                : errorText(failure?.error ?? '', failure?.code, failure?.params)}
            </span>
          ) : (
            <span className="truncate text-sm text-fg-secondary" title={candidate.description}>
              {candidate.description}
            </span>
          )}
        </span>
      </label>
    </li>
  )
}
