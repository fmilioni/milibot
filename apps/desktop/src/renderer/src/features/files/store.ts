import {
  ApiError,
  type ChatFile,
  type FilePage,
  type FileSource,
  type MessageAttachment,
  type WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import type { ToastKey } from '@/features/workspace/store'

const PAGE_SIZE = 100
const NO_COUNTS: FilePage['counts'] = { all: 0, bots: 0, user: 0 }

interface FileFilter {
  source: FileSource | null
  query: string
}

interface FilesState {
  workspaceId: string | null
  filter: FileFilter
  files: ChatFile[]
  hasMore: boolean
  counts: FilePage['counts']
  totalBytes: number
  loaded: boolean
  loading: boolean

  load(workspaceId: string, filter?: Partial<FileFilter>): Promise<void>
  loadMore(workspaceId: string): Promise<void>
  rename(workspaceId: string, attachmentId: string, name: string): Promise<void>
  remove(workspaceId: string, attachmentId: string): Promise<void>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

/** Files sent in the workspace's chats (the Files screen), one filtered list at a time. */
export const useFilesStore = create<FilesState>()((set, get) => {
  const { forWorkspace, isCurrent: current } = createWorkspaceScope(get, set, () => ({
    files: [],
    hasMore: false,
    counts: NO_COUNTS,
    totalBytes: 0,
    loaded: false,
  }))
  let request = 0

  const fetchPage = async (workspaceId: string, before?: string) => {
    const { source, query } = get().filter
    return api().call('listFiles', {
      params: { workspaceId },
      query: {
        limit: PAGE_SIZE,
        ...(source ? { source } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(before ? { before } : {}),
      },
    })
  }

  return {
    workspaceId: null,
    filter: { source: null, query: '' },
    files: [],
    hasMore: false,
    counts: NO_COUNTS,
    totalBytes: 0,
    loaded: false,
    loading: false,

    async load(workspaceId, filter) {
      forWorkspace(workspaceId)
      if (filter) set({ filter: { ...get().filter, ...filter } })
      const id = ++request
      set({ loading: true })
      try {
        const page = await fetchPage(workspaceId)
        if (id === request && current(workspaceId))
          set({
            files: page.files,
            hasMore: page.hasMore,
            counts: page.counts,
            totalBytes: page.totalBytes,
            loaded: true,
          })
      } finally {
        if (id === request) set({ loading: false })
      }
    },

    async loadMore(workspaceId) {
      const last = get().files.at(-1)
      if (!last || !get().hasMore || get().loading) return
      const id = ++request
      set({ loading: true })
      try {
        const page = await fetchPage(workspaceId, last.attachment.id)
        if (id === request && current(workspaceId))
          set({ files: [...get().files, ...page.files], hasMore: page.hasMore })
      } finally {
        if (id === request) set({ loading: false })
      }
    },

    async rename(workspaceId, attachmentId, name) {
      await api().call('renameFile', { params: { workspaceId, attachmentId }, body: { name } })
    },

    async remove(workspaceId, attachmentId) {
      await api().call('deleteFile', { params: { workspaceId, attachmentId } })
    },

    applyEvent(workspaceId, event) {
      if (!current(workspaceId) || !get().loaded || event.type !== 'attachment.updated') return
      const { attachment } = event.payload
      if (!attachment.messageId || attachment.status === 'uploading') return
      const index = get().files.findIndex((f) => f.attachment.id === attachment.id)
      const removed = attachment.status === 'removed'
      if (removed && index < 0) return
      if (removed || index < 0) {
        void get()
          .load(workspaceId)
          .catch(() => undefined)
        return
      }
      const files = [...get().files]
      const file = files[index] as ChatFile
      const { id, name, size, mimeType, path, status, image } = attachment
      files[index] = { ...file, attachment: { id, name, size, mimeType, path, status, image } }
      set({ files })
    },
  }
})

async function exportFile(workspaceId: string, attachmentId: string): Promise<string> {
  const { path } = await api().call('exportAttachment', { params: { workspaceId, attachmentId } })
  return path
}

/** Brings a chat file from the VM and asks where to save it; false when the user cancels. */
export async function saveChatFile(
  workspaceId: string,
  file: Pick<MessageAttachment, 'id' | 'name'>,
  title: string,
): Promise<boolean> {
  const sourcePath = await exportFile(workspaceId, file.id)
  return Boolean(await window.milibot.saveFileAs({ sourcePath, defaultName: file.name, title }))
}

export async function openChatFile(workspaceId: string, attachmentId: string): Promise<void> {
  await window.milibot.openPath(await exportFile(workspaceId, attachmentId))
}

export async function revealChatFile(workspaceId: string, attachmentId: string): Promise<void> {
  await window.milibot.revealPath(await exportFile(workspaceId, attachmentId))
}

/** The daemon's code of a failed file action (`VM_NOT_RUNNING`, `FILE_REMOVED`, `NAME_TAKEN`). */
export function fileErrorCode(err: unknown): string | null {
  const code = err instanceof ApiError ? (err.details as { code?: unknown } | undefined)?.code : undefined
  return typeof code === 'string' ? code : null
}

/** The toast for a failed file action: the VM off, the file gone from the VM, or anything else. */
export function fileErrorToast(err: unknown): ToastKey {
  const code = fileErrorCode(err)
  if (code === 'VM_NOT_RUNNING') return 'fileNeedsVm'
  if (code === 'FILE_REMOVED') return 'fileRemoved'
  return 'error'
}
