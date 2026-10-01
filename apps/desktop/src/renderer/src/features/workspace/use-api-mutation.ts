import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { type ToastKey, useAppStore } from '@/features/workspace/store'

interface ApiMutationOptions<A, R> {
  /** Keys (or prefixes) refetched once the call succeeds. */
  invalidates?: QueryKey[] | ((result: R, args: A) => QueryKey[])
  onSuccess?: (result: R, args: A) => void
  /** The toast shown when the call fails (default: the generic error); false: `run` rejects instead. */
  errorToast?: ToastKey | ((err: unknown) => ToastKey) | false
}

export interface ApiMutation<A, R> {
  /** Runs the call; resolves to its result, or undefined when it failed (after the toast). */
  run: (args: A) => Promise<R | undefined>
  busy: boolean
}

/** A daemon call that changes data: busy flag, error toast, and the queries it affects refetched. */
export function useApiMutation<A = void, R = unknown>(
  call: (args: A) => Promise<R>,
  { invalidates, onSuccess, errorToast = 'error' }: ApiMutationOptions<A, R> = {},
): ApiMutation<A, R> {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: call,
    onSuccess: async (result, args) => {
      const keys = typeof invalidates === 'function' ? invalidates(result, args) : (invalidates ?? [])
      await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })))
      onSuccess?.(result, args)
    },
  })
  const { mutateAsync } = mutation
  const run = useCallback(
    async (args: A) => {
      try {
        return await mutateAsync(args)
      } catch (err) {
        if (errorToast === false) throw err
        console.error('[mutation] failed', err)
        useAppStore.getState().showToast(typeof errorToast === 'function' ? errorToast(err) : errorToast)
        return undefined
      }
    },
    [mutateAsync, errorToast],
  )
  return { run, busy: mutation.isPending }
}
