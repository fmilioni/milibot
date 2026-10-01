import { useEffect, useEffectEvent, useRef, useState } from 'react'

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false

/**
 * Files dragged anywhere over the window: returns whether a drag is over it (for a `DropOverlay`) and calls
 * `onDrop` with the drop event.
 */
export function useFileDrop(onDrop: (event: DragEvent) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const drop = useEffectEvent(onDrop)
  useEffect(() => {
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current++
      setDragging(true)
    }
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDropEvent = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current = 0
      setDragging(false)
      drop(event)
    }
    document.addEventListener('dragenter', onEnter)
    document.addEventListener('dragover', onOver)
    document.addEventListener('dragleave', onLeave)
    document.addEventListener('drop', onDropEvent)
    return () => {
      document.removeEventListener('dragenter', onEnter)
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('dragleave', onLeave)
      document.removeEventListener('drop', onDropEvent)
    }
  }, [])
  return dragging
}
