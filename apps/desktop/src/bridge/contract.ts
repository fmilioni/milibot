import { type ApiClientOptions, ThemePreference } from '@milibot/shared'
import { z } from 'zod'

import {
  EVENT_CHANNELS,
  type EventName,
  INVOKE_CHANNELS,
  type InvokeName,
  SEND_CHANNELS,
  type SendName,
  type WindowKind,
} from './channels'
import { isWebUrl } from './web-url'

export type DaemonConnection = Pick<ApiClientOptions, 'baseUrl' | 'token'>

export interface WindowContext {
  workspaceId: string
  daemon: DaemonConnection
}

/** A bot's screen: main asks the daemon for its VNC port, so the page never names a port. */
export const VncTarget = z.object({ workspaceId: z.string().min(1), botId: z.string().min(1) })
export type VncTarget = z.infer<typeof VncTarget>

/** WebSocket URL of the main-process bridge to a bot's VNC port (noVNC connects to it). */
export interface VncTicket {
  url: string
}

/**
 * A bot's desktop in its own window. `login`: the user has the screen from the start (CLI login in the
 * setup); `watch`: the bot keeps control until the user takes over.
 */
export const VmWindowOptions = z.object({
  workspaceId: z.string(),
  botId: z.string(),
  title: z.string(),
  mode: z.enum(['login', 'watch']).catch('watch'),
})
export type VmWindowOptions = z.input<typeof VmWindowOptions>

export const CanvasWindowOptions = z.object({
  workspaceId: z.string(),
  designId: z.string(),
  title: z.string(),
})
export type CanvasWindowOptions = z.infer<typeof CanvasWindowOptions>

const frameSide = z.number().int().min(1).max(10_000)

/** A frame's compiled page (from `GET …/frames/:id/html`) rendered by the main process for exports. */
export const DesignExportFrame = z.object({
  name: z.string().catch('frame'),
  html: z.string(),
  width: frameSide,
  /** Null: grows with its content. */
  height: frameSide.nullable(),
})
export type DesignExportFrame = z.infer<typeof DesignExportFrame>

/** Save panel texts of an export. */
export const DesignSaveOptions = z.object({ defaultName: z.string(), title: z.string() })
export type DesignSaveOptions = z.infer<typeof DesignSaveOptions>

const HtmlFiles = z.object({ html: z.string(), source: z.string(), tokensCss: z.string() })
const OpenPanel = z.object({ title: z.string(), extensions: z.array(z.string()) })

/**
 * An error of a window's page, appended to the renderer log: `render` (caught by an error boundary; `area`
 * names it), `error` (uncaught) or `rejection` (unhandled promise).
 */
export const RendererErrorReport = z.object({
  source: z.enum(['render', 'error', 'rejection']),
  area: z.string().max(100).optional(),
  message: z.string().max(4_000),
  stack: z.string().max(20_000).optional(),
  componentStack: z.string().max(20_000).optional(),
})
export type RendererErrorReport = z.infer<typeof RendererErrorReport>

/** A CSS color the renderer sampled: hex, `rgb()`/`rgba()` or a name (nothing that could be markup). */
const CssColor = z
  .string()
  .trim()
  .regex(/^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\)|[a-z]{3,20})$/i)

/** The app keeps the computer from sleeping (`active`) while bots work (`busyBots`, every workspace). */
export interface KeepAwakeState {
  active: boolean
  /** Counted even with the option off. */
  busyBots: number
}

export const TitleBarColors = z.object({ color: CssColor, symbolColor: CssColor })
export type TitleBarColors = z.infer<typeof TitleBarColors>

const none = z.tuple([])
const result = <T>() => z.custom<T>()

const invokeEntries = {
  getContext: { args: none, result: result<WindowContext>() },
  openWorkspaceWindow: { args: z.tuple([z.string()]), result: result<void>() },
  setWindowWorkspace: { args: z.tuple([z.string(), z.string()]), result: result<void>() },
  setThemeSource: { args: z.tuple([ThemePreference]), result: result<void>() },
  /** Workspaces that currently have a window (to mark them open in the switcher). */
  listOpenWorkspaces: { args: none, result: result<string[]>() },
  openVnc: { args: z.tuple([VncTarget]), result: result<VncTicket>() },
  /** Shows a file or folder in the file manager. */
  revealPath: { args: z.tuple([z.string()]), result: result<void>() },
  /** Save panel; the chosen path or null when cancelled. */
  chooseSavePath: {
    args: z.tuple([
      z.object({
        defaultName: z.string(),
        title: z.string(),
        extension: z.enum(['zip', 'qcow2']).default('zip'),
      }),
    ]),
    result: result<string | null>(),
  },
  /** Open panel for one file with one of `extensions`; null when cancelled. */
  chooseOpenPath: { args: z.tuple([OpenPanel]), result: result<string | null>() },
  /** Open panel for files (limited to `extensions`) and folders; empty when cancelled. */
  chooseOpenPaths: { args: z.tuple([OpenPanel]), result: result<string[]>() },
  /** Copies a file the daemon exported to a temporary folder to where the user picks; null when cancelled. */
  saveFileAs: {
    args: z.tuple([z.object({ sourcePath: z.string(), defaultName: z.string(), title: z.string() })]),
    result: result<string | null>(),
  },
  /** Opens an http(s) URL in the default browser. */
  openExternal: { args: z.tuple([z.string().refine(isWebUrl)]), result: result<void>() },
  /** Opens a file with its default app (scripts and apps are shown in the file manager instead). */
  openPath: { args: z.tuple([z.string()]), result: result<void>() },
  /** A bot's desktop, sized to show `VM_DESKTOP` 1:1 when the screen has room. */
  openVmWindow: { args: z.tuple([VmWindowOptions]), result: result<void>() },
  /** Closes that window (if open) and brings the caller's window back to the front. */
  closeVmWindow: { args: z.tuple([z.string(), z.string()]), result: result<void>() },
  /** Text on the system clipboard (pasting into the VM). */
  readClipboard: { args: none, result: result<string>() },
  /** "Start in the background at login"; null where the platform has no login item. */
  getLoginItem: { args: none, result: result<boolean | null>() },
  setLoginItem: { args: z.tuple([z.boolean()]), result: result<boolean>() },
  openCanvasWindow: { args: z.tuple([CanvasWindowOptions]), result: result<void>() },
  /** Renders a frame as PNG at `scale` and asks where to save it; the path or null (cancelled). */
  exportDesignPng: {
    args: z.tuple([DesignExportFrame, z.number(), DesignSaveOptions]),
    result: result<string | null>(),
  },
  /** Frames as one PDF, a page per frame at its size. */
  exportDesignPdf: {
    args: z.tuple([z.array(DesignExportFrame).min(1), DesignSaveOptions]),
    result: result<string | null>(),
  },
  copyDesignImage: { args: z.tuple([DesignExportFrame, z.number()]), result: result<void>() },
  /** The chosen `<name>.html` (standalone page), `<name>.source.html` (as written) and `tokens.css`. */
  saveDesignHtml: { args: z.tuple([HtmlFiles, DesignSaveOptions]), result: result<string | null>() },
  /** Frames as PNGs at `scale` in one zip, a file per frame. */
  exportDesignPngZip: {
    args: z.tuple([z.array(DesignExportFrame).min(1), z.number(), DesignSaveOptions]),
    result: result<string | null>(),
  },
  /** `<name>.html` and `<name>.source.html` per frame plus `tokens.css`, in one zip. */
  saveDesignHtmlZip: {
    args: z.tuple([z.array(HtmlFiles.extend({ name: z.string() })).min(1), DesignSaveOptions]),
    result: result<string | null>(),
  },
  /** Save panel for a `.mbdesign` (the daemon writes it). */
  chooseDesignFilePath: { args: z.tuple([DesignSaveOptions]), result: result<string | null>() },
  saveMarkdownFile: { args: z.tuple([z.string(), DesignSaveOptions]), result: result<string | null>() },
  getKeepAwake: { args: none, result: result<KeepAwakeState>() },
} satisfies Record<InvokeName, { args: z.ZodTuple; result: z.ZodType }>

const sendEntries = {
  /** Conversation on screen (null: settings or none); notifications skip it while the window is focused. */
  setActiveConversation: { args: z.tuple([z.string().nullable().catch(null)]) },
  /** Windows: paints the caption buttons like what is under them. */
  setTitleBarOverlay: { args: z.tuple([TitleBarColors]) },
  reportRendererError: { args: z.tuple([RendererErrorReport]) },
} satisfies Record<SendName, { args: z.ZodTuple }>

const eventEntries = {
  /** A notification was clicked: show that conversation. */
  showConversation: { args: z.tuple([z.string(), z.string()]) },
  keepAwakeChanged: { args: z.tuple([result<KeepAwakeState>()]) },
} satisfies Record<EventName, { args: z.ZodTuple }>

function withChannels<E extends Record<string, object>, C extends { [K in keyof E]: string }>(
  entries: E,
  channels: C,
) {
  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [name, { ...entry, name, channel: channels[name] }]),
  ) as { [K in keyof E]: E[K] & { name: K; channel: C[K] } }
}

export const invokes = withChannels(invokeEntries, INVOKE_CHANNELS)
export const sends = withChannels(sendEntries, SEND_CHANNELS)
export const events = withChannels(eventEntries, EVENT_CHANNELS)

type Invokes = typeof invokes
type Sends = typeof sends
type Events = typeof events

/** What the page passes. */
type InvokeArgs<K extends InvokeName> = z.input<Invokes[K]['args']>
/** What main receives after validation. */
export type InvokeParsed<K extends InvokeName> = z.output<Invokes[K]['args']>
export type InvokeResult<K extends InvokeName> = z.output<Invokes[K]['result']>
type SendArgs<K extends SendName> = z.input<Sends[K]['args']>
export type SendParsed<K extends SendName> = z.output<Sends[K]['args']>
export type EventArgs<K extends EventName> = z.output<Events[K]['args']>

type EventSubscriptions = {
  [K in EventName as `on${Capitalize<K>}`]: (listener: (...args: EventArgs<K>) => void) => () => void
}

/**
 * `window.milibot`, built by the preload from the channel maps. A window gets only the channels its kind
 * allows (`allowedChannels`); the type lists every one.
 */
export type MilibotBridge = {
  platform: string
  windowKind: WindowKind
  /** Local path of a file or folder dropped on the window. */
  getPathForFile(file: File): string
} & { [K in InvokeName]: (...args: InvokeArgs<K>) => Promise<InvokeResult<K>> } & {
  [K in SendName]: (...args: SendArgs<K>) => void
} & EventSubscriptions
