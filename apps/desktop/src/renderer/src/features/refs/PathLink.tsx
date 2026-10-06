import type { MouseEvent, ReactNode } from 'react'

import { fileErrorCode } from '@/features/files/store'
import { type ToastKey, useAppStore } from '@/features/workspace/store'
import { FileChip } from '@/ui/RefLinks'

import { openWorkspaceFile } from './api'

const PATH_ERRORS: Record<string, ToastKey> = {
  VM_NOT_RUNNING: 'fileNeedsVmToOpen',
  FILE_REMOVED: 'fileMissing',
  NOT_A_FILE: 'notAFile',
  FILE_TOO_LARGE: 'fileTooLargeToOpen',
}

/** A `/workspace/` path in text: a click brings the file from the VM and opens it. */
export function PathLink({
  path,
  variant,
  label,
}: {
  path: string
  variant: 'text' | 'chip'
  label?: ReactNode
}) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const { workspaceId, showToast } = useAppStore.getState()
    if (!workspaceId) return
    openWorkspaceFile(workspaceId, path).catch((err: unknown) => {
      console.error('[open file]', err)
      showToast(PATH_ERRORS[fileErrorCode(err) ?? ''] ?? 'error')
    })
  }
  if (variant === 'chip')
    return (
      <a
        href={path}
        title={path}
        onClick={open}
        className="focus-ring rounded-md hover:[&>span]:border-accent"
      >
        <FileChip path={path} />
      </a>
    )
  return (
    <a
      href={path}
      title={path}
      onClick={open}
      className="focus-ring rounded-sm break-all text-accent underline underline-offset-2"
    >
      {label ?? path}
    </a>
  )
}
