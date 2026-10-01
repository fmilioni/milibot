import { api } from '@/api/daemon'

export const searchKnowledge = (workspaceId: string, query: string) =>
  api().call('searchKnowledge', { params: { workspaceId }, body: { query, topK: 6 } })

export const getKnowledgeDoc = (workspaceId: string, docId: string) =>
  api().call('getKnowledgeDoc', { params: { workspaceId, docId } })

export const getKnowledgeContent = (workspaceId: string, docId: string, part: number) =>
  api().call('getKnowledgeContent', { params: { workspaceId, docId }, query: { part } })

export const exportKnowledgeDoc = (workspaceId: string, docId: string) =>
  api().call('exportKnowledgeDoc', { params: { workspaceId, docId } })

/** Tries an embedding model once (its size is unknown until then). */
export const probeEmbeddingModel = (workspaceId: string, providerId: string, model: string) =>
  api().call('probeEmbeddingModel', { params: { workspaceId }, body: { providerId, model } })
