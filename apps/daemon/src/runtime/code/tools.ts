import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  describeToolCall,
  flagArg,
  numberArg,
  optionalInteger,
  optionalNumber,
  optionalString,
  rawTextArg,
  requireString,
  type ToolArgs,
  ToolInputError,
  toolText,
} from '@milibot/agent/tools'
import type { Bot } from '@milibot/shared'

import { type LegacyOfficeAccess, readFileForTool } from '../files'
import { clipMiddle, stripAnsi, type ToolHandlers, ToolSwitch } from '../tools-core'
import { botLinuxUser, type GuestClient, GuestError, type VmController } from '../vm'
import { applyEdits, DIFF_MAX_BYTES, EditError, fileWriteDiff, type TextEdit } from './edits'
import { appliedPatchFiles } from './patch-files'
import { fromCodexPatch, PatchError, placeBareHunks } from './patch-hunks'
import { resolveWorkspacePath } from './paths'
import { APPLY_PATCH_SCRIPT } from './scripts/apply-patch.generated'
import { GLOB_SCRIPT } from './scripts/glob.generated'
import { GREP_SCRIPT } from './scripts/grep.generated'
import {
  GLOB_RESULTS,
  GLOB_SCAN,
  globToRegex,
  GREP_DEFAULT_RESULTS,
  GREP_MAX_RESULTS,
  grepLines,
  parseGlobOutput,
} from './search'

const MAX_OUTPUT_CHARS = 15_000

const SELF_MATCHING_KILL = /\b(?:pkill|pgrep)\b[^;&|\n]*\s-(?:-full\b|[a-zA-Z]*f)|\bkillall\b/

/** A `pkill -f`-style command that died from a signal most likely matched (and killed) its own shell. */
export function killedOwnShellHint(
  command: string,
  code: number | null,
  signal: string | null,
): string | null {
  const killed = (code !== null && code > 128) || (code === null && signal !== null)
  if (!killed || !SELF_MATCHING_KILL.test(command)) return null
  return (
    'hint: the command was killed by a signal. `pkill -f`/`pgrep -f` match whole command lines, including ' +
    "the shell running this command (it contains the pattern): use a bracket pattern (`pkill -f '[v]ite " +
    "--config'`) or kill the PID you saved when you started the process."
  )
}

function workspacePath(path: string, base?: string | null): string {
  const absolute = resolveWorkspacePath(path, base ?? '/workspace')
  if (!absolute) throw new ToolInputError('file tools only work under /workspace; use bash for other paths')
  return absolute
}

function textEdits(a: ToolArgs): TextEdit[] {
  if (Array.isArray(a.edits)) {
    if (a.edits.length === 0) throw new ToolInputError('"edits" is empty')
    return a.edits.map((item, i) => {
      const e = (item && typeof item === 'object' ? item : {}) as ToolArgs
      if (typeof e.old_text !== 'string' || typeof e.new_text !== 'string')
        throw new ToolInputError(`edits[${i}] needs "old_text" and "new_text"`)
      return { oldText: e.old_text, newText: e.new_text, replaceAll: e.replace_all === true }
    })
  }
  return [
    {
      oldText: requireString(a, 'old_string'),
      newText: rawTextArg(a, 'new_string'),
      replaceAll: flagArg(a, 'replace_all') === true,
    },
  ]
}

export interface CodeToolsDeps {
  vm: Pick<VmController, 'guest'>
  /** Variables and commit identity of the bot's processes. */
  botEnv?: (bot: Bot) => Promise<Record<string, string>>
  /** Variables of one lane's commands (e.g. `MILIBOT_ALLOW_MERGE` in a session whose plan may merge). */
  laneEnv?: (ctx: ToolExecContext) => Record<string, string>
  /** Whether `file_read` can convert .doc/.xls/.ppt (LibreOffice in the VM). */
  legacyOffice?: () => LegacyOfficeAccess
  /** Where commands and relative paths start without a `cwd` (a work session's folder; default /workspace). */
  defaultCwd?: (ctx: ToolExecContext) => string | null
}

/** Shell and file tools of the bots' code work, run as the bot's Linux user under /workspace. */
function codeHandlers(deps: CodeToolsDeps): ToolHandlers {
  const cwdOf = (ctx: ToolExecContext) => deps.defaultCwd?.(ctx) ?? '/workspace'

  async function bash(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const command = requireString(a, 'command')
    const timeoutSec = numberArg(a, 'timeout_sec', { min: 1, max: 1800, fallback: 120, round: true })
    const env = {
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...((await deps.botEnv?.(ctx.bot)) ?? {}),
      ...deps.laneEnv?.(ctx),
    }
    const result = await guest.exec(
      {
        user: botLinuxUser(ctx.bot.slug),
        cmd: command,
        env,
        cwd: optionalString(a, 'cwd') ?? cwdOf(ctx),
        display: ctx.bot.displayNum,
        timeoutMs: timeoutSec * 1000,
        maxOutputBytes: 512 * 1024,
        bot: ctx.bot.slug,
      },
      ctx.signal,
    )
    const parts = [
      `exit code: ${result.code ?? 'none'}${result.signal ? ` (signal ${result.signal})` : ''}${result.timedOut ? ` — timed out after ${timeoutSec}s` : ''}`,
    ]
    const stdout = stripAnsi(result.stdout)
    const stderr = stripAnsi(result.stderr)
    if (stdout) parts.push(`stdout:\n${clipMiddle(stdout, MAX_OUTPUT_CHARS)}`)
    if (stderr) parts.push(`stderr:\n${clipMiddle(stderr, 6000)}`)
    const hint = killedOwnShellHint(command, result.code, result.signal)
    if (hint) parts.push(hint)
    return toolText(parts.join('\n'), result.code !== 0)
  }

  async function fileRead(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const start = optionalInteger(a, 'start_line', 1, Number.MAX_SAFE_INTEGER)
    const end = optionalInteger(a, 'end_line', 1, Number.MAX_SAFE_INTEGER)
    if (start !== null && end !== null && end < start)
      throw new ToolInputError('"end_line" must not be before "start_line"')
    const offset = start ?? optionalNumber(a, 'offset') ?? null
    const limit = end !== null ? end - (start ?? 1) + 1 : (optionalNumber(a, 'limit') ?? null)
    const out = await readFileForTool(guest, workspacePath(requireString(a, 'path'), cwdOf(ctx)), {
      ...(offset !== null ? { offset } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(deps.legacyOffice ? { legacyOffice: deps.legacyOffice() } : {}),
      signal: ctx.signal,
    })
    return toolText(out.text, out.isError === true)
  }

  async function fileWrite(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const content = a.content
    if (typeof content !== 'string') throw new ToolInputError('"content" must be a string')
    const path = workspacePath(requireString(a, 'path'), cwdOf(ctx))
    const before = await guest.fsRead(path, { maxBytes: DIFF_MAX_BYTES + 1 }).catch((err: unknown) => {
      if (err instanceof GuestError && err.code === 'path_not_found') return null
      return undefined
    })
    const written = await guest.fsWrite(path, content, botLinuxUser(ctx.bot.slug))
    const result = toolText(`Wrote ${written.size} bytes to ${written.path}`)
    if (before === undefined) return result
    const files = [fileWriteDiff(path, before, content)]
    return { ...result, activity: { detail: describeToolCall('file_write', a).detail, files } }
  }

  async function fileEdit(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const path = workspacePath(requireString(a, 'path'), cwdOf(ctx))
    const edits = textEdits(a)
    const file = await guest.fsRead(path)
    if (file.truncated) return toolText(`${path} is too large to edit here; use apply_patch or bash.`, true)
    let edited: { content: string; replacements: number }
    try {
      edited = applyEdits(file.content, edits)
    } catch (err) {
      if (err instanceof EditError) return toolText(`Not edited (nothing was changed): ${err.message}`, true)
      throw err
    }
    await guest.fsWrite(path, edited.content, botLinuxUser(ctx.bot.slug))
    const count = edited.replacements
    return {
      ...toolText(`Edited ${path} (${count} replacement${count === 1 ? '' : 's'})`),
      activity: {
        detail: describeToolCall('file_edit', a).detail,
        files: [fileWriteDiff(path, file, edited.content)],
      },
    }
  }

  async function grep(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const pattern = requireString(a, 'pattern')
    const base = cwdOf(ctx)
    const path = optionalString(a, 'path')
    const max = optionalInteger(a, 'max_results', 1, GREP_MAX_RESULTS) ?? GREP_DEFAULT_RESULTS
    const context = optionalInteger(a, 'context', 0, 10)
    const result = await guest.exec(
      {
        user: botLinuxUser(ctx.bot.slug),
        cmd: GREP_SCRIPT,
        cwd: base,
        env: {
          SEARCH_DIR: base,
          TARGET: path ? workspacePath(path, base) : '.',
          PATTERN: pattern,
          GLOB: optionalString(a, 'glob') ?? '',
          IGNORE_CASE: flagArg(a, 'ignore_case') === true ? '1' : '',
          CONTEXT: context === null ? '' : String(context),
        },
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        bot: ctx.bot.slug,
      },
      ctx.signal,
    )
    if (result.code !== 0 && result.code !== 1)
      return toolText(`Search failed: ${clipMiddle(result.stderr || result.stdout, 2000).trim()}`, true)
    const lines = grepLines(result.stdout)
    if (lines.length === 0) return toolText(`No matches for /${pattern}/${path ? ` in ${path}` : ''}.`)
    const shown = lines.slice(0, max)
    const more = lines.length > max || result.truncated?.stdout
    return toolText(
      `${shown.map((line) => clipMiddle(line, 500)).join('\n')}${
        more ? `\n… more matches not shown (narrow the search with path/glob, or raise max_results)` : ''
      }`,
    )
  }

  async function glob(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const pattern = requireString(a, 'pattern')
    const base = cwdOf(ctx)
    const dir = workspacePath(optionalString(a, 'path') ?? base, base)
    const result = await guest.exec(
      {
        user: botLinuxUser(ctx.bot.slug),
        cmd: GLOB_SCRIPT,
        cwd: base,
        env: { SEARCH_DIR: dir, REGEX: globToRegex(pattern), SCAN: String(GLOB_SCAN) },
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        bot: ctx.bot.slug,
      },
      ctx.signal,
    )
    if (result.code !== 0 && !result.stdout)
      return toolText(`Search failed: ${clipMiddle(result.stderr || 'no output', 2000).trim()}`, true)
    const files = parseGlobOutput(result.stdout)
    if (files.length === 0) return toolText(`No files match ${pattern} in ${dir}.`)
    const shown = files.slice(0, GLOB_RESULTS)
    const scanned = files.length >= GLOB_SCAN
    return toolText(
      `${files.length}${scanned ? '+' : ''} file${files.length === 1 ? '' : 's'} in ${dir}, most recently changed first:\n` +
        shown.join('\n') +
        (files.length > shown.length ? `\n… ${files.length - shown.length}${scanned ? '+' : ''} more` : ''),
    )
  }

  async function missingFileNote(guest: GuestClient, dir: string, path: string): Promise<string> {
    const note = `${path} does not exist in ${dir} (the cwd used; the paths in the patch are relative to it).`
    const fromRoot = dir === '/workspace' ? null : resolveWorkspacePath(path, '/workspace')
    if (!fromRoot) return note
    const exists = await guest.fsRead(fromRoot, { maxBytes: 1 }).then(
      () => true,
      () => false,
    )
    return exists
      ? `${note} ${fromRoot} exists: pass cwd "/workspace" or make the paths relative to ${dir}.`
      : note
  }

  async function applyPatch(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const base = cwdOf(ctx)
    const dir = workspacePath(optionalString(a, 'cwd') ?? base, base)
    const notApplied = (why: string) => toolText(`Patch not applied (nothing was changed):\n${why}`, true)
    let patch: string
    try {
      patch = await placeBareHunks(fromCodexPatch(requireString(a, 'patch')), async (path) => {
        const absolute = resolveWorkspacePath(path, dir)
        if (!absolute) return null
        const file = await guest.fsRead(absolute, { maxBytes: DIFF_MAX_BYTES + 1 }).catch((err: unknown) => {
          if (err instanceof GuestError && err.code === 'path_not_found') return null
          throw err
        })
        if (file?.truncated)
          throw new PatchError(
            `${path} is too large to place hunks without line numbers; use @@ -a,b +c,d @@ headers`,
          )
        return file?.content ?? null
      })
    } catch (err) {
      if (!(err instanceof PatchError)) throw err
      return notApplied(err.missingPath ? await missingFileNote(guest, dir, err.missingPath) : err.message)
    }
    const result = await guest.exec(
      {
        user: botLinuxUser(ctx.bot.slug),
        cmd: APPLY_PATCH_SCRIPT,
        cwd: dir,
        env: { PATCH_DIR: dir },
        stdin: patch.endsWith('\n') ? patch : `${patch}\n`,
        timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024,
        bot: ctx.bot.slug,
      },
      ctx.signal,
    )
    const [touched = '', applied] = result.stdout.split('::applied::')
    if (result.code !== 0 || applied === undefined) {
      const error = clipMiddle(result.stderr || result.stdout, 3000).trim()
      const missing = /^error: (.+?): (?:No such file or directory|does not exist in index)$/m.exec(
        error,
      )?.[1]
      return notApplied(
        `${error}\n${
          missing
            ? await missingFileNote(guest, dir, missing)
            : 'Read the current lines of the file and make the context lines match exactly.'
        }`,
      )
    }
    const files = touched
      .split('\n')
      .map((l) => l.trim().split('\t').slice(2).join('\t'))
      .filter(Boolean)
    const done = toolText(`Patch applied in ${dir}: ${files.length ? files.join(', ') : 'no file changes'}.`)
    const changed = appliedPatchFiles(touched, patch, dir)
    if (!changed.length) return done
    return { ...done, activity: { detail: describeToolCall('apply_patch', a).detail, files: changed } }
  }

  return {
    bash,
    file_read: fileRead,
    file_write: fileWrite,
    file_edit: fileEdit,
    grep,
    glob,
    apply_patch: applyPatch,
  }
}

export class CodeTools extends ToolSwitch {
  readonly name = 'code'
  protected readonly handlers: ToolHandlers

  constructor(deps: CodeToolsDeps) {
    super()
    this.handlers = codeHandlers(deps)
  }
}
