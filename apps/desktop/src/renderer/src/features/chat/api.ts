import { ApiError, type StepDiff } from '@milibot/shared'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/api/daemon'
import { queryKeys } from '@/api/queries'

export type StepDiffResult = { diff: StepDiff } | { missing: true }

/** A step's diff (`missing` when the daemon no longer has it); written once, so never refetched. */
export function useStepDiff(workspaceId: string, toolCallId: string) {
  return useQuery({
    queryKey: queryKeys.toolCallDiff(workspaceId, toolCallId),
    queryFn: async (): Promise<StepDiffResult> => {
      try {
        return { diff: await api().call('getToolCallDiff', { params: { workspaceId, toolCallId } }) }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_found') return { missing: true }
        throw err
      }
    },
    staleTime: Infinity,
  })
}
