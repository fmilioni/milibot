import { z } from 'zod'

import { BotScope } from '../bots/bots'
import { UploadChunkBody, UploadChunkResult, UploadFileBody, UploadProgress } from '../chat/uploads'
import { UserOrBot } from '../core/schemas'
import { endpoint, Ok, QueryBool } from '../http/endpoint'
import { EmbeddingProbeResult } from '../models/providers'
import { EmbeddingOptions, KnowledgeEmbeddingSetting, ProbeEmbeddingModelBody } from './embedding'

/*
 * Knowledge base: documents the user uploads (or adds from a chat attachment), files the bots add from the
 * VM and documents the bots write. Each one is stored on the host (`<wsDir>/knowledge/<docId>/original.<ext>`
 * + `content.md`), extracted in the VM, summarized, cut into chunks and indexed (FTS5 + embeddings). Bots
 * see a small catalog and search/read on demand.
 */

export const KnowledgeKind = z.enum([
  'pdf',
  'docx',
  'odt',
  'epub',
  'rtf',
  'html',
  'markdown',
  'text',
  'csv',
  'json',
  'code',
  'image',
  'pptx',
  'xlsx',
  'note',
])
export type KnowledgeKind = z.infer<typeof KnowledgeKind>

/** `vm_file` = `knowledge_add`, `bot` = written by a bot. */
export const KnowledgeSource = z.enum(['upload', 'attachment', 'vm_file', 'bot'])
export type KnowledgeSource = z.infer<typeof KnowledgeSource>

export const KnowledgeDocStatus = z.enum([
  'queued',
  'extracting',
  'summarizing',
  'indexing',
  'ready',
  'failed',
])
export type KnowledgeDocStatus = z.infer<typeof KnowledgeDocStatus>

export const KnowledgeDoc = z.object({
  id: z.string(),
  title: z.string(),
  fileName: z.string(),
  mime: z.string(),
  kind: KnowledgeKind,
  source: KnowledgeSource,
  /** Attachment id (`attachment`) or VM path (`vm_file`). */
  sourceRef: z.string().nullable(),
  authorType: UserOrBot,
  authorBotId: z.string().nullable(),
  conversationId: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  /** Pages (PDF), sheets (xlsx), slides (pptx), sections (other documents) or rows (csv). */
  pages: z.number().int().nullable(),
  chunks: z.number().int().nonnegative(),
  status: KnowledgeDocStatus,
  /**
   * Of a failed document, e.g. `tools_missing` (the VM lacks the extraction tools), `file_missing` (the
   * stored file is gone), `legacy_office_disabled`/`office_missing` (an old Office file without LibreOffice).
   */
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  /** Within the current status. */
  progress: z.number(),
  /** 2–4 sentences in the document's language (null until summarized). */
  summary: z.string().nullable(),
  summaryModel: z.string().nullable(),
  ocrPages: z.number().int().nonnegative(),
  pinned: z.boolean(),
  /** A bot read it or a search returned it. */
  lastUsedAt: z.number().int().nullable(),
  scope: BotScope,
  /** null = general (seen from every project). */
  projectId: z.string().nullable(),
  /** Every chunk has a vector in the space searches use (false: found by text search only). */
  embedded: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  indexedAt: z.number().int().nullable(),
})
export type KnowledgeDoc = z.infer<typeof KnowledgeDoc>

/**
 * State of the vector index. `downloading`/`loading`: the local model is being fetched or loaded;
 * `indexing`: chunks of new documents are being embedded; `reindexing`: the model changed and every chunk
 * is embedded again in the new space (searches keep using `activeSpace` until it completes);
 * `unavailable`: the model could not be used (see `error`), documents are searched by text only.
 */
export const KnowledgeIndexState = z.enum([
  'idle',
  'downloading',
  'loading',
  'indexing',
  'reindexing',
  'unavailable',
])
export type KnowledgeIndexState = z.infer<typeof KnowledgeIndexState>

export const KnowledgeIndexStatus = z.object({
  state: KnowledgeIndexState,
  embedding: KnowledgeEmbeddingSetting,
  /** null: none yet, text search only. */
  activeSpace: z.string().nullable(),
  /** The chosen model's space while it is being indexed. */
  targetSpace: z.string().nullable(),
  download: z
    .object({
      modelId: z.string(),
      progress: z.number(),
      loadedBytes: z.number(),
      totalBytes: z.number(),
    })
    .nullable(),
  /** Chunks with a vector in the target space (the active one when not reindexing), and all chunks. */
  indexedChunks: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  pendingDocs: z.number().int().nonnegative(),
  /** Waiting for the VM (extraction happens there). */
  waitingForVm: z.number().int().nonnegative(),
  /** Why embeddings are unavailable; search falls back to text. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type KnowledgeIndexStatus = z.infer<typeof KnowledgeIndexStatus>

export const KnowledgeListQuery = z.object({
  /** Searches title, file name and summary (full text + summary vectors). */
  q: z.string().max(500).optional(),
  kind: KnowledgeKind.optional(),
  /** `user`, `bot` (any bot) or a bot id. */
  author: z.string().optional(),
  status: KnowledgeDocStatus.optional(),
  pinned: QueryBool.optional(),
  /** A project id, or `general`. */
  projectId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type KnowledgeListQuery = z.input<typeof KnowledgeListQuery>

export const KnowledgeDocList = z.object({
  /** Pinned first, then most recently updated (with `q`: best match first). */
  docs: z.array(KnowledgeDoc),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  pageCount: z.number().int(),
  /** Without filters. */
  totalAll: z.number().int(),
  index: KnowledgeIndexStatus,
})
export type KnowledgeDocList = z.infer<typeof KnowledgeDocList>

const KnowledgeContentQuery = z.object({ part: z.coerce.number().int().min(1).default(1) })

/** Extracted text as markdown, in parts; `<!-- page N -->` marks where each page starts. */
export const KnowledgeContent = z.object({
  docId: z.string(),
  title: z.string(),
  part: z.number().int(),
  parts: z.number().int(),
  text: z.string(),
  summary: z.string().nullable(),
})
export type KnowledgeContent = z.infer<typeof KnowledgeContent>

export const UpdateKnowledgeDocBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  scope: BotScope.optional(),
  pinned: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
})
export type UpdateKnowledgeDocBody = z.input<typeof UpdateKnowledgeDocBody>

export const KnowledgeSearchBody = z.object({
  query: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(20).default(6),
  docId: z.string().optional(),
})
export type KnowledgeSearchBody = z.input<typeof KnowledgeSearchBody>

export const KnowledgeSearchHit = z.object({
  docId: z.string(),
  title: z.string(),
  kind: KnowledgeKind,
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  /** Heading path, e.g. "Contract › Payment". */
  heading: z.string(),
  text: z.string(),
  score: z.number(),
  /** 1-based rank in the text and vector lists (null = not found by that one). */
  textRank: z.number().int().nullable(),
  vectorRank: z.number().int().nullable(),
  /** First and last chunk (1-based, as `knowledge_read` takes them). */
  fromChunk: z.number().int(),
  toChunk: z.number().int(),
})
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHit>

export const KnowledgeSearchResult = z.object({
  hits: z.array(KnowledgeSearchHit),
  /** `text`: no vectors could be used (no model yet, model unavailable). */
  mode: z.enum(['hybrid', 'text']),
  space: z.string().nullable(),
  tookMs: z.number().int(),
})
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>

export const CreateKnowledgeUploadBody = UploadFileBody.extend({
  title: z.string().trim().min(1).max(200).optional(),
  scope: BotScope.optional(),
  projectId: z.string().nullable().optional(),
})
export type CreateKnowledgeUploadBody = z.input<typeof CreateKnowledgeUploadBody>

export const KnowledgeFromAttachmentBody = z.object({
  attachmentId: z.string(),
  title: z.string().trim().min(1).max(200).optional(),
  scope: BotScope.optional(),
  /** Default: the attachment's conversation's current project. */
  projectId: z.string().nullable().optional(),
})
export type KnowledgeFromAttachmentBody = z.input<typeof KnowledgeFromAttachmentBody>

export const DEFAULT_KNOWLEDGE_CATALOG_BUDGET_TOKENS = 400

/** The summary model is the preference `knowledgeSummaryModel`. */
export const KnowledgeSettings = z.object({
  embedding: KnowledgeEmbeddingSetting,
  /** The top chunks go with every turn's input. */
  autoRetrieve: z.boolean(),
  /** Titles of possibly relevant documents go with every turn's input. */
  suggestDocs: z.boolean(),
  /** The fixed catalog (header + pinned documents) in every bot's context. */
  catalogBudgetTokens: z.number().int().min(0).max(4000),
})
export type KnowledgeSettings = z.infer<typeof KnowledgeSettings>

export const UpdateKnowledgeSettingsBody = KnowledgeSettings.partial()
export type UpdateKnowledgeSettingsBody = z.input<typeof UpdateKnowledgeSettingsBody>

export const knowledgeEndpoints = {
  listKnowledge: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/knowledge',
    query: KnowledgeListQuery,
    response: KnowledgeDocList,
  }),
  getKnowledgeIndex: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/knowledge/index',
    response: KnowledgeIndexStatus,
  }),
  /** After a failed download or provider error. */
  retryKnowledgeIndex: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/index/retry',
    response: KnowledgeIndexStatus,
  }),
  getKnowledgeSettings: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/knowledge/settings',
    response: KnowledgeSettings,
  }),
  /** Changing `embedding` reindexes in the background (searches keep the old model until it is done). */
  updateKnowledgeSettings: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/knowledge/settings',
    body: UpdateKnowledgeSettingsBody,
    response: KnowledgeSettings,
  }),
  getEmbeddingOptions: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/knowledge/embedding-options',
    response: EmbeddingOptions,
  }),
  /** Tests a registered model before it is chosen: stores its dimensions on success (the setting is kept). */
  probeEmbeddingModel: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/embedding-options/probe',
    body: ProbeEmbeddingModelBody,
    response: EmbeddingProbeResult,
  }),
  /** The same hybrid search the bots use, without a bot scope. */
  searchKnowledge: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/search',
    body: KnowledgeSearchBody,
    response: KnowledgeSearchResult,
  }),
  /** Refused above the attachment size limit. */
  createKnowledgeUpload: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/uploads',
    body: CreateKnowledgeUploadBody,
    response: UploadProgress,
  }),
  uploadKnowledgeChunk: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/uploads/:uploadId/chunks',
    body: UploadChunkBody,
    response: UploadChunkResult,
  }),
  completeKnowledgeUpload: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/uploads/:uploadId/complete',
    response: KnowledgeDoc,
  }),
  cancelKnowledgeUpload: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/knowledge/uploads/:uploadId',
    response: Ok,
  }),
  /** A copy; the attachment stays. */
  addKnowledgeFromAttachment: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/from-attachment',
    body: KnowledgeFromAttachmentBody,
    response: KnowledgeDoc,
  }),
  getKnowledgeDoc: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/knowledge/:docId',
    response: KnowledgeDoc,
  }),
  getKnowledgeContent: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/knowledge/:docId/content',
    query: KnowledgeContentQuery,
    response: KnowledgeContent,
  }),
  updateKnowledgeDoc: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/knowledge/:docId',
    body: UpdateKnowledgeDocBody,
    response: KnowledgeDoc,
  }),
  deleteKnowledgeDoc: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/knowledge/:docId',
    response: Ok,
  }),
  /** From the stored file. */
  reindexKnowledgeDoc: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/:docId/reindex',
    response: KnowledgeDoc,
  }),
  /** Copies the original file (`content.md` for bot documents) to a temporary folder on the host. */
  exportKnowledgeDoc: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/knowledge/:docId/export',
    response: z.object({ path: z.string(), fileName: z.string() }),
  }),
}
