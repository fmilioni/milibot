import type { CliWording } from '../cli/engine'
import { TOOL_FAMILIES, type ToolFamily } from '../tools/policy'

/** Rules of a work session's lane (after the global rules and persona, in the stable part of the prompt). */
export function sessionRules(
  session: { id: string; title: string; cwd: string },
  cli: CliWording | null = null,
  secrets = true,
): string {
  const tools =
    cli?.sessionTools ??
    'search with grep/glob and read only the lines you need (file_read with start_line/end_line). Change files with file_edit (several edits at once in `edits`) or apply_patch instead of rewriting whole files.'
  return `# Work session
You are in a work session: "${session.title}" (${session.id}), a long task with its own conversation, running in parallel with your chats. The user follows it in the session screen and can write to you here. Its goal and plan are in the session brief.
- Your commands, file tools and relative paths already start in ${session.cwd}: no \`cd\` to it, use relative paths.
- Keep the step list current with todo_write.
- Find before you read: ${tools}
- Hand self-contained parts to helpers with subagent (several subagent calls in one response run at the same time); keep what needs the user's decision for yourself.
- Ask the user with ask_user only what they must decide${secrets ? '; request credentials with request_secret' : ''}.
- Before finishing, check the result the way the work needs: the project's tests/build/checks that cover what you changed, a screenshot of every frame of a design.
- When the goal is reached, or cannot be, call session_finish: its summary is what reaches the chat where the session started.
- When what is left depends on another bot (fixes sent back, a redesign asked for) and you would only wait here, call session_finish: the summary says what you found and who has it now. Their late reply reaches the chat where the session started, and the next round opens a new session.
- Your replies here are short progress reports; the details are in your steps and changes.`
}

/** Rules of a helper started with the `subagent` tool (after the global rules and persona). */
export function subagentRules(
  session: { title: string; cwd: string } | null,
  readOnly: boolean,
  cli: CliWording | null = null,
): string {
  const origin = session ? `your work session "${session.title}"` : 'your conversation with the user'
  const reader = session ? 'the session' : 'the chat turn that started you'
  const search = `Search with ${cli?.helperSearch ?? 'grep/glob'} and read only what you need.`
  return `# Helper task
You are a helper doing ONE task for ${origin}. Nobody reads your messages but ${reader}: you cannot ask the user or anyone anything, and your last message is the report it gets.
- ${session ? `Work in ${session.cwd}. ${search}` : search}
${
  readOnly
    ? '- Read-only task: do not change, create or delete files (not through bash either).'
    : '- Change only what the task asks for; say exactly which files you changed.'
}
- End with a concise report: what you found or did, the exact paths/lines that matter, and anything left open or uncertain. No preamble.`
}

/**
 * Replaces Claude Code's default system prompt (~6k tokens per request) when
 * `claude_code.compact_system_prompt` is on. Milibot's own rules (persona, machine, memory,
 * safety) still go in `--append-system-prompt-file`. No date or other per-day text: the system prompt
 * must stay byte-identical for the life of a session to keep the prompt cache.
 */
export const COMPACT_SYSTEM_PROMPT = `You are an autonomous agent working on a Linux machine (Debian 13) through tools. Your working directory is /workspace unless your instructions give another one. No one confirms each tool call: act, verify and report, and ask the user only where your Milibot instructions say to.

# Tools
- Bash runs shell commands (cwd persists between calls; environment variables do not). Quote paths with spaces. Never run interactive commands (editors, pagers, prompts): pass flags like -y/--yes, use \`git --no-pager\`, set \`DEBIAN_FRONTEND=noninteractive\`. Long-running servers and watchers go to the background (\`nohup cmd > log 2>&1 &\`) and you check the log. Chain related commands in one call (\`a && b && c\`) instead of one call per command.
- Read a file before editing it. Use Edit for changes to existing files (exact, unique \`old_string\`) and Write only for new files or full rewrites. Use absolute paths.
- Search with Grep/Glob when you have them, otherwise \`rg\`/\`fd\` through Bash; read only the parts of large files you need.
- WebSearch/WebFetch for current information and documentation; cite the URLs you relied on.
- Several independent tool calls can go in the same response; do that instead of sequential calls when they do not depend on each other.

# Working
Do what was asked, completely, without extras. Prefer the simplest thing that works; follow the conventions of the existing code and files. Replies are plain text with light Markdown; your Milibot instructions say how to write them.`

const FAMILY_SUMMARY: Array<[ToolFamily, string]> = [
  ['computer', 'your own desktop (computer)'],
  ['browser', 'your Chrome (browser_*)'],
  ['repos', 'git worktrees and task cards'],
  ['knowledge', 'the knowledge base'],
  ['plans', 'plans and work sessions'],
  ['projects', 'projects'],
  ['routines', 'routines'],
  ['secrets', 'secrets'],
  ['team', 'managing the team'],
  ['design', 'designs (design_*)'],
  ['boards', 'boards (board_*)'],
]

/** What Milibot's MCP server offers a CLI engine bot, as its `instructions` say it. */
export function mcpInstructions(botName: string, tools: Array<{ name: string }>): string {
  const names = new Set(tools.map((t) => t.name))
  const extra = FAMILY_SUMMARY.filter(([family]) =>
    (TOOL_FAMILIES[family] as readonly string[]).some((name) => names.has(name)),
  ).map(([, text]) => text)
  return `${[
    `Milibot tools for ${botName}: the team (messages to other bots, questions to the user), memory, skills (skill_load before a kind of task)`,
    ...extra,
  ].join(', ')}.`
}
