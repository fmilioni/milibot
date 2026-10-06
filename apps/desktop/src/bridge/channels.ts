// Imported by the sandboxed preload, which can only run bundled code: keep this file free of zod and
// of anything else that is not plain data.

export type WindowKind = 'workspace' | 'canvas' | 'vm'

export const INVOKE_CHANNELS = {
  getContext: 'milibot:get-context',
  openWorkspaceWindow: 'milibot:open-workspace-window',
  setWindowWorkspace: 'milibot:set-window-workspace',
  setThemeSource: 'milibot:set-theme-source',
  listOpenWorkspaces: 'milibot:list-open-workspaces',
  openVnc: 'milibot:open-vnc',
  revealPath: 'milibot:reveal-path',
  chooseSavePath: 'milibot:choose-save-path',
  chooseOpenPath: 'milibot:choose-open-path',
  chooseOpenPaths: 'milibot:choose-open-paths',
  saveFileAs: 'milibot:save-file-as',
  openExternal: 'milibot:open-external',
  openPath: 'milibot:open-path',
  openVmWindow: 'milibot:open-vm-window',
  closeVmWindow: 'milibot:close-vm-window',
  readClipboard: 'milibot:read-clipboard',
  getLoginItem: 'milibot:get-login-item',
  setLoginItem: 'milibot:set-login-item',
  openCanvasWindow: 'milibot:open-canvas-window',
  exportDesignPng: 'milibot:export-design-png',
  exportDesignPdf: 'milibot:export-design-pdf',
  copyDesignImage: 'milibot:copy-design-image',
  saveDesignHtml: 'milibot:save-design-html',
  exportDesignPngZip: 'milibot:export-design-png-zip',
  saveDesignHtmlZip: 'milibot:save-design-html-zip',
  chooseDesignFilePath: 'milibot:choose-design-file-path',
  saveMarkdownFile: 'milibot:save-markdown-file',
  getKeepAwake: 'milibot:get-keep-awake',
} as const

/** One-way messages from the page. */
export const SEND_CHANNELS = {
  setActiveConversation: 'milibot:set-active-conversation',
  setTitleBarOverlay: 'milibot:set-title-bar-overlay',
  reportRendererError: 'milibot:report-renderer-error',
} as const

/** Main → page messages; the bridge exposes each as `on<Name>(listener)`. */
export const EVENT_CHANNELS = {
  showConversation: 'milibot:show-conversation',
  keepAwakeChanged: 'milibot:keep-awake-changed',
} as const

export type InvokeName = keyof typeof INVOKE_CHANNELS
export type SendName = keyof typeof SEND_CHANNELS
export type EventName = keyof typeof EVENT_CHANNELS
export type ChannelName = InvokeName | SendName | EventName

const ALL_CHANNELS = [
  ...Object.keys(INVOKE_CHANNELS),
  ...Object.keys(SEND_CHANNELS),
  ...Object.keys(EVENT_CHANNELS),
] as ChannelName[]

/** Everything a bot's screen window renders (`VmWindow` and the noVNC viewer). */
const VM_CHANNELS: readonly ChannelName[] = [
  'getContext',
  'openVnc',
  'readClipboard',
  'setThemeSource',
  'setTitleBarOverlay',
  'reportRendererError',
]

/** The canvas window renders neither settings, the setup, the sidebar nor the VM panel. */
const NOT_IN_CANVAS: readonly ChannelName[] = [
  'openWorkspaceWindow',
  'listOpenWorkspaces',
  'chooseSavePath',
  'chooseOpenPath',
  'openVmWindow',
  'closeVmWindow',
  'getLoginItem',
  'setLoginItem',
  'setActiveConversation',
  'showConversation',
  'getKeepAwake',
  'keepAwakeChanged',
]

const SURFACES: Record<WindowKind, ReadonlySet<ChannelName>> = {
  workspace: new Set(ALL_CHANNELS),
  canvas: new Set(ALL_CHANNELS.filter((name) => !NOT_IN_CANVAS.includes(name))),
  vm: new Set(VM_CHANNELS),
}

/** What a window of this kind may call: the preload exposes only these, and main refuses the others. */
export function allowedChannels(kind: WindowKind): ReadonlySet<ChannelName> {
  return SURFACES[kind]
}

/** Passed to the preload through `webPreferences.additionalArguments`. */
export const WINDOW_KIND_ARG = '--milibot-window-kind='

export function windowKindFromArgv(argv: readonly string[]): WindowKind | null {
  const value = argv.find((arg) => arg.startsWith(WINDOW_KIND_ARG))?.slice(WINDOW_KIND_ARG.length)
  return value === 'workspace' || value === 'canvas' || value === 'vm' ? value : null
}
