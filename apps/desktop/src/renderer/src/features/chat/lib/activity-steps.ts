import type { ActivityStep } from '@milibot/shared'
import type { TFunction } from 'i18next'
import {
  AppWindow,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  BookmarkPlus,
  BookOpenText,
  BookPlus,
  BookSearch,
  Brain,
  Brush,
  CalendarClock,
  Camera,
  ChartColumn,
  CircleCheckBig,
  ClipboardCheck,
  ClipboardList,
  ClipboardPen,
  Clock,
  Cpu,
  Eye,
  FileDown,
  FilePen,
  FilePenLine,
  FileSearch,
  FileText,
  FileUp,
  FileX,
  FolderGit2,
  FolderKanban,
  FolderOpen,
  FolderPen,
  FolderPlus,
  Frame,
  GitBranch,
  GitPullRequest,
  Globe,
  History,
  ImagePlus,
  Keyboard,
  KeyRound,
  Layers,
  LayoutTemplate,
  Library,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTodo,
  MessageCircleQuestion,
  MessageSquarePlus,
  MessageSquareText,
  MousePointer2,
  MousePointerClick,
  MoveVertical,
  NotebookPen,
  Palette,
  Pause,
  PencilRuler,
  PenTool,
  Plug,
  Puzzle,
  RefreshCw,
  Rocket,
  ScanText,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  SquareKanban,
  SquareMousePointer,
  SquareTerminal,
  SwatchBook,
  Trash2,
  UserMinus,
  UserPen,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react'

const STEP_ICONS: Record<string, typeof Wrench> = {
  screenshot: Camera,
  click: MousePointer2,
  double_click: MousePointer2,
  triple_click: MousePointer2,
  right_click: MousePointer2,
  middle_click: MousePointer2,
  move: MousePointer2,
  drag: MousePointer2,
  scroll: MoveVertical,
  type: Keyboard,
  key: Keyboard,
  wait: Pause,
  bash: SquareTerminal,
  file_read: FileText,
  file_write: FilePen,
  file_edit: FilePen,
  file_list: FolderOpen,
  chart: ChartColumn,
  create_bot: UserPlus,
  update_bot: UserPen,
  list_bots: Users,
  repo_checkout: GitBranch,
  repo_list: FolderGit2,
  repo_release: GitBranch,
  note: MessageSquareText,
  search: FileSearch,
  web_fetch: Globe,
  web_search: Search,
  generate_image: ImagePlus,
  subtask: Layers,
  tool: Wrench,
  memory_save: BookmarkPlus,
  update_own_prompt: NotebookPen,
  set_model: Cpu,
  memory_search: Brain,
  history_search: History,
  knowledge_search: BookSearch,
  knowledge_read: BookOpenText,
  knowledge_list: Library,
  knowledge_add: BookPlus,
  knowledge_write: FilePenLine,
  knowledge_edit: FilePenLine,
  knowledge_delete: FileX,
  computer_batch: ListOrdered,
  browser_snapshot: ScanText,
  browser_navigate: Globe,
  browser_back: ArrowLeft,
  browser_forward: ArrowUpRight,
  browser_reload: RefreshCw,
  browser_click: MousePointerClick,
  browser_type: Keyboard,
  browser_press_key: Keyboard,
  browser_select_option: SquareMousePointer,
  browser_scroll: MoveVertical,
  browser_wait_for: Clock,
  browser_tabs: AppWindow,
  browser_tab_new: AppWindow,
  browser_tab_select: AppWindow,
  browser_tab_close: AppWindow,
  ask_bot: MessageCircleQuestion,
  ask_user: MessageCircleQuestion,
  request_secret: KeyRound,
  list_secrets: List,
  message_bot: Send,
  after_current_work: Clock,
  create_group: Users,
  add_member: UserPlus,
  remove_member: UserMinus,
  delete_bot: Trash2,
  mcp: Plug,
  skill_load: Puzzle,
  skill_read: FileSearch,
  skill_save: BookmarkPlus,
  skill_delete: Trash2,
  routine_create: CalendarClock,
  routine_list: CalendarClock,
  routine_update: CalendarClock,
  routine_delete: Trash2,
  report_task: GitPullRequest,
  share_file: FileUp,
  project_list: FolderKanban,
  project_create: FolderPlus,
  project_update: FolderPen,
  project_set_current: FolderOpen,
  plan_write: ClipboardPen,
  plan_submit: ClipboardCheck,
  plan_get: ClipboardList,
  plan_search: Search,
  todo_write: ListTodo,
  plan_step: ListChecks,
  session_start: Rocket,
  session_finish: CircleCheckBig,
  list_models: Cpu,
  design_create: Palette,
  design_list: LayoutTemplate,
  design_read: LayoutTemplate,
  design_set_tokens: SwatchBook,
  design_write_frame: PenTool,
  design_edit_frame: PencilRuler,
  design_draw: Brush,
  design_frame: Frame,
  design_screenshot: Eye,
  design_export: FileDown,
  design_archive: Archive,
  design_delete: Trash2,
  board_create: SquareKanban,
  board_list: SquareKanban,
  board_get: SquareKanban,
  board_update: SquareKanban,
  board_delete: Trash2,
  board_card_write: SquareKanban,
  board_card_get: SquareKanban,
  board_comment: MessageSquarePlus,
  board_link: Link2,
  board_search: Search,
  workspace_settings_get: Settings2,
  workspace_settings_update: SlidersHorizontal,
  mcp_server_list: Plug,
  mcp_server_add: Plug,
  mcp_server_update: Plug,
  mcp_server_remove: Trash2,
  mcp_server_test: RefreshCw,
  mcp_server_connect: KeyRound,
}

/** Steps whose detail is a command or code, shown in monospace. */
const MONO_KINDS = new Set(['bash', 'file_read', 'file_write', 'file_edit', 'file_list'])

/** Tool names models borrow from other harnesses (the host refuses them), shown as the file tool they meant. */
const KIND_ALIASES: Record<string, string> = { write: 'file_write', edit: 'file_edit', read: 'file_read' }

function canonicalKind(kind: string): string {
  return KIND_ALIASES[kind.toLowerCase()] ?? kind
}

export function stepIcon(kind: string) {
  return STEP_ICONS[canonicalKind(kind)] ?? Wrench
}

const SCREEN_KINDS = new Set([
  'computer_batch',
  'screenshot',
  'click',
  'double_click',
  'triple_click',
  'right_click',
  'middle_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'wait',
])

/** What a running step can be watched on: the bot's desktop, the design canvas, or nothing (terminal, files). */
export function stepWatchTarget(kind: string): 'screen' | 'design' | null {
  if (SCREEN_KINDS.has(kind) || kind.startsWith('browser_')) return 'screen'
  if (kind.startsWith('design_') && kind !== 'design_list') return 'design'
  return null
}

/** Name of the design a design step worked on (its detail is "Design · Frame"). */
export function stepDesignName(step: Pick<ActivityStep, 'kind' | 'detail'>): string | null {
  if (stepWatchTarget(step.kind) !== 'design') return null
  return step.detail.split(' · ')[0]?.trim() || null
}

const FILE_KINDS = ['file_read', 'file_write', 'file_edit'] as const
type FileKind = (typeof FILE_KINDS)[number]

/** A failed file step whose detail is the path: shown as "Could not edit <name>" instead of the raw path. */
export function failedFileStep(step: Pick<ActivityStep, 'kind' | 'detail' | 'status'>): FileKind | null {
  const kind = FILE_KINDS.find((k) => k === canonicalKind(step.kind))
  if (step.status !== 'error' || !kind || !step.detail.includes('/')) return null
  return kind
}

export function isMonoKind(kind: string): boolean {
  return MONO_KINDS.has(canonicalKind(kind))
}

/** "list_bots" → "list bots", "NotebookRead" → "Notebook Read". */
function humanToolName(name: string): string {
  return name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
}

/** Details that say nothing to a person (raw JSON arguments, `true`). */
function meaningless(detail: string): boolean {
  const d = detail.trim()
  return /^[[{]/.test(d) || /^(true|false|null|undefined|:)$/.test(d)
}

/**
 * Human line of a step ("Clicked at (640, 772)"); commands and paths are shown as they are. A kind the app
 * does not know reads as "Used <tool name>", never as its raw arguments.
 */
export function stepText(
  step: Pick<ActivityStep, 'kind' | 'detail'>,
  t: TFunction,
  rawDetail = step.detail,
): string {
  // A refused call to a borrowed name can also arrive as the generic kind with the name as its detail.
  const borrowed = step.kind === 'tool' ? KIND_ALIASES[rawDetail.trim().toLowerCase()] : undefined
  const detail = borrowed || meaningless(rawDetail) ? '' : rawDetail
  const kind = borrowed ?? canonicalKind(step.kind)
  const key = `chat.activity.kinds.${kind}`
  if (STEP_ICONS[kind] === undefined || !t(key, { defaultValue: '' }))
    return String(t('chat.activity.kinds.tool', { detail: humanToolName(kind) })).trim()
  if (MONO_KINDS.has(kind) && detail) return detail
  // Steps without a detail (or whose detail is only known after running) read on their own.
  if (!detail) {
    const bare = String(t(`${key}_empty`, { defaultValue: '' }))
    if (bare) return bare
  }
  return String(t(key, { detail, defaultValue: detail })).trim()
}
