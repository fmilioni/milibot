import {
  ApiError,
  type Attachment,
  DEFAULT_ATTACHMENT_MAX_FILE_MB,
  type WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { splitDesignFiles, UploadCancelled, uploadFile } from '@/features/chat/lib/attachment-upload'
import { apiErrorReason } from '@/lib/errors'
export { sendableAttachmentIds } from '@/features/chat/lib/attachment-upload'
import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { useAppStore } from '@/features/workspace/store'

/** A file in the composer: sending to the daemon, then waiting for (or copying into) the VM. */
export interface PendingAttachment {
  key: string
  name: string
  size: number
  type: string
  /** Object URL of an image (thumbnail), revoked when the chip goes away. */
  previewUrl: string | null
  /** 0..1 of the bytes sent to the daemon. */
  uploaded: number
  attachment: Attachment | null
  error: 'too_large' | 'failed' | null
}

interface AttachmentState {
  /** Workspace `maxFileMb` was read from. */
  workspaceId: string | null
  byConversation: Record<string, PendingAttachment[]>
  maxFileMb: number
  addFiles(workspaceId: string, conversationId: string, files: File[]): void
  remove(workspaceId: string, conversationId: string, key: string): void
  /** After sending: the chips leave the composer (the message shows them now). */
  clear(conversationId: string): void
  loadSettings(workspaceId: string): Promise<void>
}

const controllers = new Map<string, AbortController>()
let counter = 0

function update(conversationId: string, key: string, patch: Partial<PendingAttachment>): void {
  const { byConversation } = useAttachmentStore.getState()
  const items = byConversation[conversationId]
  if (!items?.some((i) => i.key === key)) return
  useAttachmentStore.setState({
    byConversation: {
      ...byConversation,
      [conversationId]: items.map((i) => (i.key === key ? { ...i, ...patch } : i)),
    },
  })
}

/** A `.mbdesign` dropped or picked in the chat becomes a new design of the conversation, opened at once. */
function importDesign(workspaceId: string, conversationId: string, file: File): void {
  const { showToast, openCanvas } = useAppStore.getState()
  void api()
    .call('importDesign', {
      params: { workspaceId },
      body: { path: window.milibot.getPathForFile(file), conversationId },
    })
    .then((design) => {
      showToast('designImported')
      return openCanvas(design.id, conversationId)
    })
    .catch((err: unknown) => {
      const reason = apiErrorReason(err)
      showToast(
        reason === 'design_file_invalid'
          ? 'designImportInvalid'
          : reason === 'design_file_too_new'
            ? 'designImportTooNew'
            : 'designImportFailed',
      )
    })
}

export const useAttachmentStore = create<AttachmentState>((set, get) => {
  const { forWorkspace, commit } = createWorkspaceScope(get, set, () => ({
    maxFileMb: DEFAULT_ATTACHMENT_MAX_FILE_MB,
  }))
  const drop = (conversationId: string, keep: (item: PendingAttachment) => boolean) => {
    const items = get().byConversation[conversationId] ?? []
    for (const item of items) {
      if (keep(item)) continue
      controllers.get(item.key)?.abort()
      controllers.delete(item.key)
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    set({ byConversation: { ...get().byConversation, [conversationId]: items.filter(keep) } })
  }

  const start = (workspaceId: string, conversationId: string, item: PendingAttachment, file: File) => {
    const controller = new AbortController()
    controllers.set(item.key, controller)
    void uploadFile(file, {
      signal: controller.signal,
      create: (body) => api().call('createAttachment', { params: { workspaceId, conversationId }, body }),
      chunk: (attachmentId, offset, data) =>
        api().call('uploadAttachmentChunk', {
          params: { workspaceId, attachmentId },
          body: { offset, data },
        }),
      complete: (attachmentId) => api().call('completeAttachment', { params: { workspaceId, attachmentId } }),
      onCreated: (attachment) => update(conversationId, item.key, { attachment }),
      onProgress: (uploaded) => update(conversationId, item.key, { uploaded }),
    })
      .then((attachment) => {
        controllers.delete(item.key)
        const current = get().byConversation[conversationId]?.find((i) => i.key === item.key)
        // An event may already have moved it further (queued → copying → ready).
        if (current?.attachment && current.attachment.status !== 'uploading') return
        update(conversationId, item.key, { attachment, uploaded: 1 })
      })
      .catch((err: unknown) => {
        controllers.delete(item.key)
        if (err instanceof UploadCancelled || controller.signal.aborted) return
        const details =
          err instanceof ApiError ? (err.details as { reason?: string; maxFileMb?: number }) : null
        const tooLarge = details?.reason === 'too_large'
        if (tooLarge && details?.maxFileMb) commit(workspaceId, { maxFileMb: details.maxFileMb })
        update(conversationId, item.key, { error: tooLarge ? 'too_large' : 'failed' })
      })
  }

  return {
    workspaceId: null,
    byConversation: {},
    maxFileMb: DEFAULT_ATTACHMENT_MAX_FILE_MB,

    addFiles(workspaceId, conversationId, given) {
      const { designs, others: files } = splitDesignFiles(given)
      for (const file of designs) importDesign(workspaceId, conversationId, file)
      const maxBytes = get().maxFileMb * 1024 * 1024
      const added = files.map((file): PendingAttachment => ({
        key: `local-${++counter}`,
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        uploaded: 0,
        attachment: null,
        error: file.size > maxBytes ? 'too_large' : null,
      }))
      set({
        byConversation: {
          ...get().byConversation,
          [conversationId]: [...(get().byConversation[conversationId] ?? []), ...added],
        },
      })
      added.forEach((item, index) => {
        if (!item.error) start(workspaceId, conversationId, item, files[index] as File)
      })
    },

    remove(workspaceId, conversationId, key) {
      const item = get().byConversation[conversationId]?.find((i) => i.key === key)
      drop(conversationId, (i) => i.key !== key)
      const attachmentId = item?.attachment?.id
      if (attachmentId)
        void api()
          .call('deleteAttachment', { params: { workspaceId, attachmentId } })
          .catch(() => undefined)
    },

    clear(conversationId) {
      drop(conversationId, () => false)
    },

    async loadSettings(workspaceId) {
      forWorkspace(workspaceId)
      try {
        const settings = await api().call('getAttachmentSettings', { params: { workspaceId } })
        commit(workspaceId, { maxFileMb: settings.maxFileMb })
      } catch {
        /* keeps the default; the daemon enforces the limit anyway */
      }
    },
  }
})

/** A composer chip follows its attachment (copied into the VM, failed). */
export function applyAttachmentEvent(_workspaceId: string, event: WorkspaceEvent): void {
  if (event.type !== 'attachment.updated') return
  const attachment = event.payload.attachment
  const items = useAttachmentStore.getState().byConversation[attachment.conversationId]
  const item = items?.find((i) => i.attachment?.id === attachment.id)
  if (item) update(attachment.conversationId, item.key, { attachment })
}
