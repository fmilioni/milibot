import {
  ApiError,
  DEFAULT_ATTACHMENT_MAX_FILE_MB,
  type EmbeddingOptions,
  type KnowledgeDoc,
  type KnowledgeDocList,
  type KnowledgeDocStatus,
  type KnowledgeIndexStatus,
  type KnowledgeKind,
  type KnowledgeSettings,
  type UpdateKnowledgeDocBody,
  type UpdateKnowledgeSettingsBody,
  type WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { UploadCancelled, uploadFile } from '@/features/chat/lib/attachment-upload'
import {
  type UploadProblem,
  uploadProblemFromError,
  validateUpload,
} from '@/features/knowledge/lib/knowledge'
import { useSettingsStore } from '@/features/settings/store'

export interface KnowledgeFilters {
  q: string
  kind: KnowledgeKind | ''
  /** `''` any, `user`, `bot` (any bot) or a bot id. */
  author: string
  status: KnowledgeDocStatus | ''
  /** `''` any, `general` (no project) or a project id. */
  project: string
  page: number
}

export const EMPTY_FILTERS: KnowledgeFilters = {
  q: '',
  kind: '',
  author: '',
  status: '',
  project: '',
  page: 1,
}
const KNOWLEDGE_PAGE_SIZE = 50

/** A file being sent from "Add documents" or dropped on the section. */
export interface KnowledgeUploadItem {
  key: string
  name: string
  size: number
  /** 0..1 of the bytes sent. */
  progress: number
  problem: UploadProblem | null
}

interface KnowledgeState {
  workspaceId: string | null
  filters: KnowledgeFilters
  list: KnowledgeDocList | null
  loading: boolean
  loadError: boolean
  index: KnowledgeIndexStatus | null
  settings: KnowledgeSettings | null
  options: EmbeddingOptions | null
  uploads: KnowledgeUploadItem[]
  maxFileMb: number
  /** Attachments added from the chat in this session (attachment id → document id). */
  fromAttachments: Record<string, string>

  load(workspaceId: string): Promise<void>
  reload(workspaceId: string): Promise<void>
  setFilters(workspaceId: string, patch: Partial<KnowledgeFilters>): void
  loadSettings(workspaceId: string): Promise<void>
  updateSettings(workspaceId: string, patch: UpdateKnowledgeSettingsBody): Promise<void>
  loadOptions(workspaceId: string): Promise<void>
  retryIndex(workspaceId: string): Promise<void>
  updateDoc(workspaceId: string, docId: string, body: UpdateKnowledgeDocBody): Promise<void>
  deleteDoc(workspaceId: string, docId: string): Promise<void>
  reindexDoc(workspaceId: string, docId: string): Promise<void>
  upload(workspaceId: string, files: File[]): void
  /** Turns "Old Office files" (knowledge.legacyOffice) on and sends again the files refused for it. */
  enableLegacyOfficeAndRetry(workspaceId: string): Promise<void>
  cancelUpload(key: string): void
  dismissUpload(key: string): void
  addFromAttachment(workspaceId: string, attachmentId: string): Promise<KnowledgeDoc>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

/** Files refused because "Old Office files" is off, kept to send again once it is on. */
const refusedFiles = new Map<string, File>()

const controllers = new Map<string, AbortController>()
let uploadCounter = 0
let reloadTimer: ReturnType<typeof setTimeout> | undefined
let filterTimer: ReturnType<typeof setTimeout> | undefined
let listRequest = 0
let listLoadedAt = 0

export const useKnowledgeStore = create<KnowledgeState>()((set, get) => {
  const { forWorkspace, isCurrent, commit } = createWorkspaceScope(get, set, () => ({
    filters: EMPTY_FILTERS,
    list: null,
    index: null,
    settings: null,
    options: null,
    uploads: [],
  }))

  const replaceDoc = (doc: KnowledgeDoc): boolean => {
    const list = get().list
    if (!list?.docs.some((d) => d.id === doc.id)) return false
    set({ list: { ...list, docs: list.docs.map((d) => (d.id === doc.id ? doc : d)) } })
    return true
  }

  /** New or removed documents move pages and totals around: read the page again (at most every 400 ms). */
  const scheduleReload = () => {
    if (reloadTimer) return
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      const workspaceId = get().workspaceId
      if (workspaceId)
        void get()
          .reload(workspaceId)
          .catch(() => undefined)
    }, 400)
  }

  const updateUpload = (key: string, patch: Partial<KnowledgeUploadItem>) =>
    set({ uploads: get().uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)) })

  return {
    workspaceId: null,
    filters: EMPTY_FILTERS,
    list: null,
    loading: false,
    loadError: false,
    index: null,
    settings: null,
    options: null,
    uploads: [],
    maxFileMb: DEFAULT_ATTACHMENT_MAX_FILE_MB,
    fromAttachments: {},

    async load(workspaceId) {
      forWorkspace(workspaceId)
      void api()
        .call('getAttachmentSettings', { params: { workspaceId } })
        .then((s) => commit(workspaceId, { maxFileMb: s.maxFileMb }))
        .catch(() => undefined)
      await Promise.all([
        get().reload(workspaceId),
        get().loadSettings(workspaceId),
        get()
          .loadOptions(workspaceId)
          .catch(() => undefined),
      ])
    },

    async reload(workspaceId) {
      const { q, kind, author, status, project, page } = get().filters
      const request = ++listRequest
      set({ loading: true })
      try {
        const list = await api().call('listKnowledge', {
          params: { workspaceId },
          query: {
            ...(q.trim() ? { q: q.trim() } : {}),
            ...(kind ? { kind } : {}),
            ...(author ? { author } : {}),
            ...(status ? { status } : {}),
            ...(project ? { projectId: project } : {}),
            page,
            pageSize: KNOWLEDGE_PAGE_SIZE,
          },
        })
        if (request !== listRequest || !isCurrent(workspaceId)) return
        // A page past the end (documents deleted meanwhile): show the last one.
        if (list.page > list.pageCount && list.pageCount > 0) {
          set({ filters: { ...get().filters, page: list.pageCount } })
          return get().reload(workspaceId)
        }
        listLoadedAt = Date.now()
        set({ list, index: list.index, loadError: false })
      } catch (err) {
        if (request === listRequest) set({ loadError: true })
        throw err
      } finally {
        if (request === listRequest) set({ loading: false })
      }
    },

    setFilters(workspaceId, patch) {
      const filters = { ...get().filters, ...patch }
      if (!('page' in patch)) filters.page = 1
      set({ filters })
      clearTimeout(filterTimer)
      filterTimer = setTimeout(
        () =>
          void get()
            .reload(workspaceId)
            .catch(() => undefined),
        'q' in patch ? 250 : 0,
      )
    },

    async loadSettings(workspaceId) {
      commit(workspaceId, { settings: await api().call('getKnowledgeSettings', { params: { workspaceId } }) })
    },

    async updateSettings(workspaceId, patch) {
      const previous = get().settings
      if (previous) set({ settings: { ...previous, ...patch } })
      try {
        const settings = await api().call('updateKnowledgeSettings', { params: { workspaceId }, body: patch })
        if (!commit(workspaceId, { settings })) return
        if (patch.embedding) {
          void get()
            .loadOptions(workspaceId)
            .catch(() => undefined)
          commit(workspaceId, { index: await api().call('getKnowledgeIndex', { params: { workspaceId } }) })
        }
      } catch (err) {
        commit(workspaceId, { settings: previous })
        throw err
      }
    },

    async loadOptions(workspaceId) {
      commit(workspaceId, { options: await api().call('getEmbeddingOptions', { params: { workspaceId } }) })
    },

    async retryIndex(workspaceId) {
      commit(workspaceId, { index: await api().call('retryKnowledgeIndex', { params: { workspaceId } }) })
    },

    async updateDoc(workspaceId, docId, body) {
      const current = get().list?.docs.find((d) => d.id === docId)
      if (current) replaceDoc({ ...current, ...body })
      try {
        const doc = await api().call('updateKnowledgeDoc', { params: { workspaceId, docId }, body })
        if (!isCurrent(workspaceId)) return
        replaceDoc(doc)
        if (body.pinned !== undefined) scheduleReload()
      } catch (err) {
        if (current) replaceDoc(current)
        throw err
      }
    },

    async deleteDoc(workspaceId, docId) {
      await api().call('deleteKnowledgeDoc', { params: { workspaceId, docId } })
      const list = get().list
      if (list && isCurrent(workspaceId))
        set({ list: { ...list, docs: list.docs.filter((d) => d.id !== docId) } })
      scheduleReload()
    },

    async reindexDoc(workspaceId, docId) {
      const doc = await api().call('reindexKnowledgeDoc', { params: { workspaceId, docId } })
      if (isCurrent(workspaceId)) replaceDoc(doc)
    },

    upload(workspaceId, files) {
      const max = get().maxFileMb
      const filterProject = get().filters.project
      const projectId = filterProject && filterProject !== 'general' ? filterProject : null
      const settings = useSettingsStore.getState()
      const legacyOffice = settings.workspaceId === workspaceId && settings.preferences?.legacyOffice === true
      const items = files.map((file): KnowledgeUploadItem => ({
        key: `kup-${++uploadCounter}`,
        name: file.name,
        size: file.size,
        progress: 0,
        problem: validateUpload(file, max, legacyOffice),
      }))
      set({ uploads: [...get().uploads, ...items] })
      items.forEach((item, index) => {
        if (item.problem === 'legacy_office_disabled') refusedFiles.set(item.key, files[index] as File)
        if (item.problem) return
        const controller = new AbortController()
        controllers.set(item.key, controller)
        void uploadFile(files[index] as File, {
          signal: controller.signal,
          create: (body) =>
            api().call('createKnowledgeUpload', {
              params: { workspaceId },
              body: { ...body, ...(projectId ? { projectId } : {}) },
            }),
          chunk: (uploadId, offset, data) =>
            api().call('uploadKnowledgeChunk', { params: { workspaceId, uploadId }, body: { offset, data } }),
          complete: (uploadId) =>
            api().call('completeKnowledgeUpload', { params: { workspaceId, uploadId } }),
          onProgress: (progress) => updateUpload(item.key, { progress }),
        })
          .then(() => {
            controllers.delete(item.key)
            set({ uploads: get().uploads.filter((u) => u.key !== item.key) })
            if (isCurrent(workspaceId)) scheduleReload()
          })
          .catch((err: unknown) => {
            controllers.delete(item.key)
            if (err instanceof UploadCancelled || controller.signal.aborted) return
            const { problem, maxFileMb } = uploadProblemFromError(
              err instanceof ApiError ? err.details : null,
            )
            if (maxFileMb) set({ maxFileMb })
            if (problem === 'legacy_office_disabled') refusedFiles.set(item.key, files[index] as File)
            updateUpload(item.key, { problem })
          })
      })
    },

    async enableLegacyOfficeAndRetry(workspaceId) {
      await useSettingsStore.getState().updatePreferences(workspaceId, { legacyOffice: true })
      const keys = get()
        .uploads.filter((u) => u.problem === 'legacy_office_disabled')
        .map((u) => u.key)
      const files = keys.flatMap((key) => refusedFiles.get(key) ?? [])
      for (const key of keys) refusedFiles.delete(key)
      set({ uploads: get().uploads.filter((u) => !keys.includes(u.key)) })
      if (files.length) get().upload(workspaceId, files)
    },

    cancelUpload(key) {
      controllers.get(key)?.abort()
      controllers.delete(key)
      set({ uploads: get().uploads.filter((u) => u.key !== key) })
    },

    dismissUpload(key) {
      refusedFiles.delete(key)
      set({ uploads: get().uploads.filter((u) => u.key !== key) })
    },

    async addFromAttachment(workspaceId, attachmentId) {
      const doc = await api().call('addKnowledgeFromAttachment', {
        params: { workspaceId },
        body: { attachmentId },
      })
      set({ fromAttachments: { ...get().fromAttachments, [attachmentId]: doc.id } })
      return doc
    },

    applyEvent(workspaceId, event) {
      if (!isCurrent(workspaceId)) return
      if (event.type === 'knowledge.doc.updated') {
        const { doc } = event.payload
        if (doc.source === 'attachment' && doc.sourceRef && !get().fromAttachments[doc.sourceRef])
          set({ fromAttachments: { ...get().fromAttachments, [doc.sourceRef]: doc.id } })
        if (!get().list || replaceDoc(doc)) return
        // Progress of a document on another page changes nothing here; a new or finished one may.
        if (doc.createdAt >= listLoadedAt - 2000 || doc.status === 'ready' || doc.status === 'failed')
          scheduleReload()
      } else if (event.type === 'knowledge.doc.deleted') {
        const list = get().list
        const { docId } = event.payload
        if (list?.docs.some((d) => d.id === docId))
          set({ list: { ...list, docs: list.docs.filter((d) => d.id !== docId) } })
        const fromAttachments = Object.fromEntries(
          Object.entries(get().fromAttachments).filter(([, id]) => id !== docId),
        )
        set({ fromAttachments })
        if (list) scheduleReload()
      } else if (event.type === 'knowledge.index.status') {
        const previous = get().index
        set({ index: event.payload.status })
        // Download finished or the model changed: the options show what is on disk now.
        if (
          previous &&
          (previous.state !== event.payload.status.state ||
            previous.activeSpace !== event.payload.status.activeSpace)
        )
          void get()
            .loadOptions(workspaceId)
            .catch(() => undefined)
      }
    },
  }
})
