import type { TaskPayload } from '@milibot/shared'
import { ArrowUpRight, GitPullRequest } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { LinkifiedText } from '@/ui/LinkifiedText'
import { Tooltip } from '@/ui/Tooltip'

const TASK_STATUS_CLASS: Record<TaskPayload['status'], string> = {
  done: 'bg-success-soft text-success',
  review: 'bg-warning-tint text-warning',
  open: 'bg-accent-soft text-accent',
  failed: 'bg-danger-tint text-danger',
}

const TASK_DOT_CLASS: Record<TaskPayload['status'], string> = {
  done: 'bg-success',
  review: 'bg-warning',
  open: 'bg-accent',
  failed: 'bg-danger',
}

export function TaskCard({ payload }: { payload: TaskPayload }) {
  const { t } = useTranslation()
  const url = payload.url && /^https?:\/\//.test(payload.url) ? payload.url : null
  const ref = [payload.prNumber ? `#${payload.prNumber}` : null, payload.branch].filter(Boolean).join(' ')
  return (
    <div className="flex h-[37px] items-center gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3">
      <span className="max-w-[60%] shrink-0 truncate text-base font-semibold text-fg">
        <LinkifiedText text={payload.title} />
      </span>
      {ref && (
        <>
          <GitPullRequest size={13} className="shrink-0 text-[#8B5CF6]" />
          <span className="min-w-0 truncate font-mono text-sm text-fg-muted">{ref}</span>
        </>
      )}
      <span className="flex-1" />
      <span
        className={`flex shrink-0 items-center gap-[5px] rounded-full px-2 py-0.5 text-xs font-semibold ${TASK_STATUS_CLASS[payload.status]}`}
      >
        <span className={`size-1.5 rounded-full ${TASK_DOT_CLASS[payload.status]}`} />
        {t(`chat.task.status.${payload.status}`)}
      </span>
      {url && (
        <Tooltip content={t('chat.task.open')}>
          <button
            type="button"
            onClick={() => void window.milibot.openExternal(url)}
            aria-label={t('chat.task.open')}
            className="focus-ring shrink-0 rounded text-fg-muted hover:text-fg"
          >
            <ArrowUpRight size={13} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
