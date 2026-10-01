import { useTranslation } from 'react-i18next'

import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { DiffPanel } from '@/ui/diff/DiffPanel'
import { DiffViewer } from '@/ui/diff/DiffViewer'

import { useStepDiff } from './api'

/** One file of a step's changes, unfolded under its line in the activity card. */
export function StepFileDiff({ toolCallId, path }: { toolCallId: string; path: string }) {
  const { t } = useTranslation()
  const { data: loaded, error, isFetching, refetch } = useStepDiff(useWorkspaceId(), toolCallId)
  const file = loaded && 'diff' in loaded ? loaded.diff.files.find((f) => f.path === path) : undefined
  return (
    <DiffPanel
      compact
      className="mt-1 mb-1.5 ml-[21px] overflow-hidden rounded-lg border border-border"
      truncated={file?.truncated}
      data={loaded ? { file } : null}
      error={Boolean(error) && !isFetching}
      onRetry={() => void refetch()}
      errorText={t('chat.activity.diff.loadFailed')}
    >
      {({ file }) =>
        file ? (
          <DiffViewer patch={file.patch} language={file.language} mode="unified" maxHeight={420} />
        ) : (
          <p className="px-3 py-4 text-center text-sm text-fg-muted">{t('chat.activity.diff.unavailable')}</p>
        )
      }
    </DiffPanel>
  )
}
