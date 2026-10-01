import RFB from '@novnc/novnc'
import { useEffect, useEffectEvent, useRef } from 'react'

import { type TeachInput, toNative } from '@/features/vm/lib/teach-recording'
import { cn } from '@/lib/cn'
import { isHostPaste, platformKind } from '@/lib/platform'

export type VncStatus = 'connecting' | 'connected' | 'disconnected'

interface VncViewerProps {
  workspaceId: string
  botId: string
  viewOnly: boolean
  label: string
  onStatus?: (status: VncStatus) => void
  /** User input on the canvas (native coordinates), while it is interactive; used by "Teach". */
  onInput?: (input: TeachInput) => void
  /**
   * The host paste shortcut (Cmd+V on the Mac, Ctrl+V on Linux/Windows) pastes the host clipboard into
   * the VM (terminal and Chrome paste with Ctrl+Shift+V).
   */
  hostPaste?: boolean
}

const XK = { Control_L: 0xffe3, Shift_L: 0xffe1, Alt_L: 0xffe9, V: 0x0056 }
/** The VNC server needs a moment to take the new clipboard before the paste keystroke. */
const PASTE_DELAY_MS = 200

const RETRY_MS = [500, 1000, 2000, 4000, 8000]

/**
 * noVNC canvas scaled to fit (the guest is always 1280×800). The WebSocket goes to the main-process
 * bridge, which dials the bot's loopback VNC port with a per-window ticket. While interactive, what is
 * copied in the VM goes to the host clipboard.
 */
export function VncViewer({
  workspaceId,
  botId,
  viewOnly,
  label,
  onStatus,
  onInput,
  hostPaste,
}: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const isViewOnly = useEffectEvent(() => viewOnly)
  const reportStatus = useEffectEvent((status: VncStatus) => onStatus?.(status))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = async () => {
      reportStatus('connecting')
      let url: string
      try {
        url = (await window.milibot.openVnc({ workspaceId, botId })).url
      } catch {
        scheduleRetry()
        return
      }
      if (disposed) return
      const rfb = new RFB(container, url, { shared: true, wsProtocols: ['binary'] })
      rfb.scaleViewport = true
      rfb.resizeSession = false
      rfb.clipViewport = false
      rfb.focusOnClick = true
      rfb.background = 'transparent'
      rfb.qualityLevel = 6
      rfb.viewOnly = isViewOnly()
      rfb.addEventListener('connect', () => {
        attempt = 0
        reportStatus('connected')
      })
      // Focus check: a bot copying while the user is in another app never overwrites the host clipboard.
      rfb.addEventListener('clipboard', (event) => {
        const { text } = event.detail
        if (text && document.hasFocus()) void navigator.clipboard.writeText(text).catch(() => {})
      })
      rfb.addEventListener('disconnect', () => {
        if (rfbRef.current === rfb) rfbRef.current = null
        if (!disposed) {
          reportStatus('disconnected')
          scheduleRetry()
        }
      })
      rfbRef.current = rfb
    }

    const scheduleRetry = () => {
      if (disposed) return
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 8000
      attempt++
      retry = setTimeout(() => void connect(), delay)
    }

    void connect()
    return () => {
      disposed = true
      clearTimeout(retry)
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [workspaceId, botId])

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly
  }, [viewOnly])

  const pasting = Boolean(hostPaste) && !viewOnly
  useEffect(() => {
    const container = containerRef.current
    if (!container || !pasting) return
    const kind = platformKind()
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isHostPaste(event, kind)) return
      event.preventDefault()
      event.stopPropagation()
      void window.milibot.readClipboard().then((text) => {
        const rfb = rfbRef.current
        if (!rfb || !text) return
        // noVNC already sent the modifier down (Cmd as Alt on the Mac, Ctrl elsewhere); let go of it so
        // the VM sees a plain Ctrl+Shift+V.
        if (kind === 'mac') rfb.sendKey(XK.Alt_L, 'MetaLeft', false)
        else rfb.sendKey(XK.Control_L, 'ControlLeft', false)
        rfb.clipboardPasteFrom(text)
        setTimeout(() => {
          rfb.sendKey(XK.Control_L, 'ControlLeft', true)
          rfb.sendKey(XK.Shift_L, 'ShiftLeft', true)
          rfb.sendKey(XK.V, 'KeyV', true)
          rfb.sendKey(XK.V, 'KeyV', false)
          rfb.sendKey(XK.Shift_L, 'ShiftLeft', false)
          rfb.sendKey(XK.Control_L, 'ControlLeft', false)
        }, PASTE_DELAY_MS)
      })
    }
    container.addEventListener('keydown', onKeyDown, { capture: true })
    return () => container.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [pasting])

  const reportInput = useEffectEvent((input: TeachInput) => onInput?.(input))
  const capturing = Boolean(onInput) && !viewOnly
  useEffect(() => {
    const container = containerRef.current
    if (!container || !capturing) return
    // Capture phase: seen before noVNC handles (and possibly stops) the event on its canvas.
    const rect = () => (container.querySelector('canvas') ?? container).getBoundingClientRect()
    // The panel may reflow while the button is down (a new step appears): map the release with the
    // rectangle of the press, so a click never turns into a drag.
    let pressRect: DOMRect | null = null
    const native = (event: MouseEvent, box: DOMRect = rect()) => toNative(event.clientX, event.clientY, box)
    const onMouseDown = (event: MouseEvent) => {
      pressRect = rect()
      reportInput({ type: 'mouse_down', ...native(event, pressRect), button: event.button, at: Date.now() })
    }
    const onMouseUp = (event: MouseEvent) => {
      reportInput({
        type: 'mouse_up',
        ...native(event, pressRect ?? rect()),
        button: event.button,
        at: Date.now(),
      })
      pressRect = null
    }
    const onWheel = (event: WheelEvent) =>
      reportInput({ type: 'wheel', ...native(event), dx: event.deltaX, dy: event.deltaY, at: Date.now() })
    const onKeyDown = (event: KeyboardEvent) =>
      reportInput({
        type: 'key',
        key: event.key,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
        at: Date.now(),
      })
    const options = { capture: true, passive: true }
    container.addEventListener('mousedown', onMouseDown, options)
    window.addEventListener('mouseup', onMouseUp, options)
    container.addEventListener('wheel', onWheel, options)
    container.addEventListener('keydown', onKeyDown, options)
    return () => {
      container.removeEventListener('mousedown', onMouseDown, options)
      window.removeEventListener('mouseup', onMouseUp, options)
      container.removeEventListener('wheel', onWheel, options)
      container.removeEventListener('keydown', onKeyDown, options)
    }
  }, [capturing])

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      // noVNC draws the remote cursor as the canvas CSS cursor, which is blank while only watching.
      className={cn(
        'absolute inset-0 overflow-hidden',
        viewOnly && 'cursor-default [&_canvas]:cursor-default!',
      )}
    />
  )
}
