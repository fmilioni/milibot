import type { Bot } from '@milibot/shared'
import type { TFunction } from 'i18next'

/** Statuses in which the bot is busy on a turn; the UI reads all of them as "working". */
const BUSY_STATUSES: ReadonlySet<string> = new Set(['thinking', 'working', 'talking', 'effort'])

export function isBusyStatus(status: string | null | undefined): boolean {
  return BUSY_STATUSES.has(status ?? '')
}

/** Tool kinds (Milibot tools and Claude Code native tools, lowercased) → `bot.activity.*` key. */
const ACTIVITY_KEYS = {
  computer: 'computer',
  computer_batch: 'computer',
  screenshot: 'computer',
  click: 'computer',
  double_click: 'computer',
  triple_click: 'computer',
  right_click: 'computer',
  middle_click: 'computer',
  move: 'computer',
  drag: 'computer',
  scroll: 'computer',
  type: 'computer',
  key: 'computer',
  wait: 'computer',
  bash: 'terminal',
  file_read: 'files',
  read: 'files',
  file_write: 'files',
  write: 'files',
  file_edit: 'files',
  edit: 'files',
  multiedit: 'files',
  notebookedit: 'files',
  file_list: 'files',
  glob: 'files',
  grep: 'files',
  ls: 'files',
  search: 'files',
  webfetch: 'web',
  web_fetch: 'web',
  websearch: 'web',
  web_search: 'web',
  memory_save: 'memory',
  update_own_prompt: 'memory',
  memory_search: 'memory',
  history_search: 'memory',
  skill_load: 'skills',
  skill_read: 'skills',
  skill_save: 'skills',
  skill_delete: 'skills',
  routine_create: 'routines',
  routine_list: 'routines',
  routine_update: 'routines',
  routine_delete: 'routines',
  message_bot: 'talk',
  ask_bot: 'talk',
  repo_checkout: 'repo',
  repo_list: 'repo',
  repo_release: 'repo',
  report_task: 'repo',
  share_file: 'files',
  list_bots: 'team',
  create_bot: 'team',
  update_bot: 'team',
  create_group: 'team',
  add_member: 'team',
  remove_member: 'team',
  delete_bot: 'team',
  mcp: 'external',
  browser_snapshot: 'browser',
  browser_navigate: 'browser',
  browser_back: 'browser',
  browser_forward: 'browser',
  browser_reload: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_press_key: 'browser',
  browser_select_option: 'browser',
  browser_scroll: 'browser',
  browser_wait_for: 'browser',
  browser_tabs: 'browser',
  browser_tab_new: 'browser',
  browser_tab_select: 'browser',
  browser_tab_close: 'browser',
  ask_user: 'waitingUser',
  request_secret: 'waitingUser',
  plan_submit: 'waitingUser',
  plan_write: 'plans',
  plan_get: 'plans',
  plan_search: 'plans',
  todo_write: 'plans',
  design_create: 'design',
  design_list: 'design',
  design_read: 'design',
  design_set_tokens: 'design',
  design_write_frame: 'design',
  design_edit_frame: 'design',
  design_draw: 'design',
  design_frame: 'design',
  design_screenshot: 'design',
  design_export: 'design',
  design_archive: 'design',
  design_delete: 'design',
  board_create: 'plans',
  board_list: 'plans',
  board_get: 'plans',
  board_update: 'plans',
  board_delete: 'plans',
  board_card_write: 'plans',
  board_card_get: 'plans',
  board_comment: 'plans',
  board_link: 'plans',
  board_search: 'plans',
} as const

export type ActivityKey = (typeof ACTIVITY_KEYS)[keyof typeof ACTIVITY_KEYS]

/** What a busy bot is doing, from the tool kind of its status; unknown kinds read as plain work. */
export function statusActivity(detail: string | null | undefined): ActivityKey | null {
  const kind = detail
    ?.trim()
    .replace(/^mcp__[^_]+__/, '')
    .toLowerCase()
  if (!kind || !Object.hasOwn(ACTIVITY_KEYS, kind)) return null
  return ACTIVITY_KEYS[kind as keyof typeof ACTIVITY_KEYS]
}

/** A busy bot blocked on an `ask_user`/`request_secret`/`plan_submit` card: what it asked for, or null. */
export function waitingForUser(
  status: string | null | undefined,
  detail: StatusDetail | null | undefined,
): 'secret' | 'question' | 'plan' | null {
  if (!isBusyStatus(status)) return null
  const kind = detail?.detail
    ?.trim()
    .replace(/^mcp__[^_]+__/, '')
    .toLowerCase()
  if (kind === 'plan_submit') return 'plan'
  return kind === 'request_secret' ? 'secret' : kind === 'ask_user' ? 'question' : null
}

/** Detail of the last `bot.status` of a bot: the tool kind and, for ask_bot/message_bot, who it talks to. */
export interface StatusDetail {
  detail?: string | undefined
  targetBotId?: string | undefined
}

/**
 * Localized one-line status: "Available", "Paused", or what a busy bot is doing ("Using the
 * computer…", "Talking to Iris…"), "Working…" when there is nothing more specific.
 * Raw tool or action ids are never shown.
 */
export function botStatusLabel(
  status: string | null | undefined,
  detail: StatusDetail | null | undefined,
  t: TFunction,
  bots: Record<string, Pick<Bot, 'name'>> = {},
): string {
  if (!isBusyStatus(status)) return status === 'paused' ? t('bot.status.paused') : t('bot.status.idle')
  const activity = statusActivity(detail?.detail)
  if (!activity) return t('bot.status.busy')
  if (activity === 'talk') {
    const target = detail?.targetBotId ? bots[detail.targetBotId] : undefined
    return target ? t('bot.activity.talk', { name: target.name }) : t('bot.activity.talkUnknown')
  }
  return t(`bot.activity.${activity}`)
}

/**
 * Next stored detail for a `bot.status` event. Between tool calls the bot goes back to `thinking`:
 * it keeps the last activity until it writes (`talking`) or stops being busy, so the label does not
 * flicker back to "Working…" on every step. Waiting for the user is over once it thinks again.
 */
export function nextStatusDetail(
  previous: StatusDetail | undefined,
  event: { status: string; detail?: string | undefined; targetBotId?: string | undefined },
): StatusDetail | undefined {
  if (event.detail) return { detail: event.detail, targetBotId: event.targetBotId }
  if (event.status === 'thinking' || event.status === 'effort')
    return statusActivity(previous?.detail) === 'waitingUser' ? undefined : previous
  return undefined
}
