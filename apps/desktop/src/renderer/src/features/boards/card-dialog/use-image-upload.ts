import type { Board } from '@milibot/shared'
import { useState } from 'react'

import { useBoardStore } from '@/features/boards/store'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'

export const IMAGE_TYPES = ['image/png', 'image/jpeg']

export function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith('image/'))
}

/** Uploads PNG/JPEG files to the board and returns their markdown; other types are skipped with a toast. */
export function useImageUpload(board: Board) {
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const uploadImage = useBoardStore((s) => s.uploadImage)
  const [uploading, setUploading] = useState(0)
  const upload = async (files: File[]): Promise<string[]> => {
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type))
    if (images.length < files.length) showToast('boardImageType')
    setUploading((n) => n + images.length)
    const out: string[] = []
    for (const file of images) {
      try {
        out.push((await uploadImage(workspaceId, board.id, file)).markdown)
      } catch {
        showToast('error')
      } finally {
        setUploading((n) => n - 1)
      }
    }
    return out
  }
  return { uploading: uploading > 0, upload }
}
