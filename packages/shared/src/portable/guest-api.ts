// Contract of the guest agent's HTTP API (vm/guest-agent) with the daemon and @milibot/agent.

export interface GuestErrorBody {
  error: { code: string; message: string }
}

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
  timedOut: boolean
  durationMs: number
}

/** Paths of the guest agent's routes; `:name` segments are parameters (`guestPath` fills them). */
export const GUEST_ROUTES = {
  ping: '/ping',
  health: '/health',
  stats: '/stats',
  bots: '/bots',
  provisionBot: '/bots/provision',
  removeBot: '/bots/remove',
  limits: '/limits',
  workspaceEstimate: '/archive/workspace/estimate',
  workspaceTar: '/archive/workspace',
  workspaceExtract: '/archive/workspace/extract',
  office: '/office',
  officeInstall: '/office/install',
  officeRemove: '/office/remove',
  extract: '/extract',
  screenshot: '/display/:n/screenshot',
  input: '/display/:n/input',
  exec: '/exec',
  procs: '/procs',
  procEvents: '/procs/:id/events',
  procStdin: '/procs/:id/stdin',
  procSignal: '/procs/:id/signal',
  fsRead: '/fs/read',
  fsWrite: '/fs/write',
} as const

export type GuestRoute = (typeof GUEST_ROUTES)[keyof typeof GUEST_ROUTES]

/** `route` with each `:name` segment replaced by the encoded parameter. */
export function guestPath(route: GuestRoute, params: Record<string, string | number> = {}): string {
  return route.replace(/:([a-z]+)/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`missing guest route parameter ${name}`)
    return encodeURIComponent(String(value))
  })
}

/** `POST /exec`: runs a command to completion (stdin travels in the JSON). */
export interface GuestExecRequest {
  /** Default `agent`. */
  user?: string
  cmd?: string
  argv?: string[]
  /** Default `/workspace`. */
  cwd?: string
  env?: Record<string, string>
  display?: number
  timeoutMs?: number
  maxOutputBytes?: number
  stdin?: string
  /** Slug of the bot the work is for: runs inside its systemd slice (per-bot limits). */
  bot?: string
}

export interface GuestDisplayStatus {
  slug: string
  uid?: number
  display: number
  running: boolean
}

/** `GET /health`. */
export interface GuestHealth {
  ok: boolean
  /** Short sha256 of the running agent bundle (agents from before it existed don't send it). */
  agentSha?: string | null
  hostname: string
  node?: string
  dataDiskMounted: boolean
  displays: GuestDisplayStatus[]
}

/** An entry of `GET /procs`. */
export interface GuestProcInfo {
  id: string
  pid?: number
  user?: string
  label?: string
  startedAt?: number
  exitedAt?: number
  running: boolean
  exit?: { code: number | null; signal: string | null }
  firstSeq?: number
  lastSeq?: number
}

export interface GuestFsReadResult {
  path: string
  size: number
  offset?: number
  content: string
  truncated: boolean
}

export interface GuestFsWriteResult {
  path: string
  size: number
  type?: string
  mode?: string
  uid?: number
  gid?: number
  mtimeMs?: number
}

/** A result of `POST /limits`. */
export interface GuestAppliedLimits {
  slug: string
  ok: boolean
  error?: string
}

/** `POST /archive/workspace/estimate`. */
export interface GuestWorkspaceEstimate {
  bytes: number
  entries?: number
}

/** `POST /archive/workspace/extract`. */
export interface GuestWorkspaceExtract {
  ok: boolean
  code: number | null
  stderr: string
}

/** `POST /procs`: a long-running process whose output is read from `/procs/:id/events`. */
export interface GuestProcSpec {
  /** Default `agent`. */
  user?: string
  cmd?: string
  argv?: string[]
  /** Default `/workspace`. */
  cwd?: string
  env?: Record<string, string>
  display?: number
  label?: string
  /** Slug of the bot the process works for (it runs in that bot's resource slice). */
  bot?: string
}

/** Buffered events of a process (`seq` increases by one; `t` = epoch ms). */
export type GuestProcRecord =
  | { seq: number; t: number; type: 'stdout' | 'stderr'; data: string; partial?: boolean }
  | { seq: number; t: number; type: 'exit'; code: number | null; signal: string | null }
  | { seq: number; t: number; type: 'error'; message: string }

/** NDJSON lines of `GET /procs/:id/events`: the process events plus a heartbeat every 15 s. */
export type GuestProcEvent = GuestProcRecord | { type: 'heartbeat' }

export interface GuestCpuTimes {
  totalTicks: number
  /** idle + iowait */
  idleTicks: number
}

export interface GuestMemoryInfo {
  totalBytes: number
  availableBytes: number
  /** Buffers + Cached + SReclaimable: memory the kernel hands back when a program needs it. */
  cacheBytes: number
}

export interface GuestCgroupUsage {
  /** Working set: memory.current minus inactive_file (page cache the kernel can drop first). */
  memoryBytes: number
  cpuUsageUsec: number
}

export interface GuestDiskStats {
  path: string
  totalBytes: number
  usedBytes: number
}

export interface GuestBotStats extends GuestCgroupUsage {
  slug: string
}

/** `GET /stats`: raw counters; CPU usage needs two samples. */
export interface GuestStats {
  at: number
  uptimeSec: number
  cpus: number
  loadavg: number[]
  cpu: GuestCpuTimes
  memory: GuestMemoryInfo
  disks: GuestDiskStats[]
  bots: GuestBotStats[]
}

/** `/limits`: a bot's systemd slice limits. */
export interface BotLimits {
  /** CPUQuota in percent of one CPU (150 = one and a half cores). */
  cpuPercent: number | null
  memoryMb: number | null
}

/** `POST /bots/provision`; `ready` = its desktop answered. */
export interface ProvisionedBot {
  slug: string
  user: string
  uid: number
  display: number
  vncPort: number
  home: string
  ready: boolean
}

export type MouseButton = 'left' | 'middle' | 'right'

/** `POST /display/:n/input` actions. */
export type InputAction =
  | {
      type: 'click' | 'double_click' | 'triple_click' | 'right_click' | 'middle_click'
      x: number
      y: number
      button?: MouseButton
    }
  | { type: 'move'; x: number; y: number }
  | { type: 'mouse_down' | 'mouse_up'; x?: number; y?: number; button?: MouseButton }
  | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number }; button?: MouseButton }
  | { type: 'scroll'; x?: number; y?: number; dx?: number; dy?: number }
  | { type: 'type'; text: string; delayMs?: number }
  | { type: 'key'; keys: string | string[] }
  | { type: 'wait'; ms: number }

export const EXTRACT_KINDS = [
  'pdf',
  'docx',
  'odt',
  'epub',
  'rtf',
  'html',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'ods',
  'odp',
  'image',
  'csv',
  'tsv',
  'markdown',
  'text',
] as const
export type ExtractKind = (typeof EXTRACT_KINDS)[number]

/** Largest body `POST /extract` accepts. */
export const MAX_EXTRACT_BYTES = 50 * 1024 * 1024

export interface ExtractedPage {
  /** 1-based: the real page of a PDF, the sheet/slide number, or the section number of pseudo-pages. */
  n: number
  text: string
  /** The text came from OCR (scanned page or image). */
  ocr: boolean
  title?: string
}

export interface ExtractMeta {
  title?: string
  /** Pages (sheets, slides, sections) of the whole document; `pages` has fewer when a range or a limit applies. */
  pageCount: number
  /** PDF pages and images are real pages; other kinds are cut in sections at headings (~3.5k characters). */
  pseudoPages: boolean
  /** Pages without a text layer that were not OCR'd (beyond the OCR limit). */
  ocrSkipped: number[]
  /** More pages than the limit, or more text than the output limit: the end is missing. */
  truncated: boolean
  durationMs: number
}

export interface ExtractResult {
  kind: ExtractKind
  pages: ExtractedPage[]
  meta: ExtractMeta
}

export type GuestOfficeState = 'absent' | 'installing' | 'installed' | 'removing' | 'error'
export type GuestOfficePhase = 'preparing' | 'downloading' | 'installing' | 'removing'

/** `GET /office`: LibreOffice in the VM. */
export interface GuestOfficeStatus {
  state: GuestOfficeState
  installed: boolean
  phase: GuestOfficePhase | null
  /** 0..1 of the whole install or removal (null when nothing runs). */
  progress: number | null
  error: string | null
  /** What failed when `state` is `error`. */
  failed: 'install' | 'remove' | null
}
