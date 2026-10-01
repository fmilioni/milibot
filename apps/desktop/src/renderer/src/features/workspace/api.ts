import { api } from '@/api/daemon'

/** Data URL of a blob (screenshots, images). */
export async function loadBlobSrc(workspaceId: string, sha: string): Promise<string> {
  const blob = await api().call('getBlob', { params: { workspaceId, sha } })
  return `data:${blob.mediaType};base64,${blob.data}`
}
