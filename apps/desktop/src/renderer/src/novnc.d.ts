declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean
    credentials?: { username?: string; password?: string; target?: string }
    repeaterID?: string
    wsProtocols?: string[]
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions)
    viewOnly: boolean
    focusOnClick: boolean
    clipViewport: boolean
    dragViewport: boolean
    scaleViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(options?: FocusOptions): void
    blur(): void
    sendCtrlAltDel(): void
    /** `down` omitted: press and release. */
    sendKey(keysym: number, code: string | null, down?: boolean): void
    /** Sets the server's clipboard (ClientCutText). */
    clipboardPasteFrom(text: string): void
  }
}
