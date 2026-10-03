import { posix } from 'node:path'

import type { Bot, InstructionFileInfo } from '@milibot/shared'

import type { AgentEnvironment, RepoInstructionFile } from '../../environment'
import type { ChatMessage, ContentPart, ToolCall } from '../../llm/messages'
import { truncateToolContent } from '../../memory/chat-messages'
import {
  isRepoInstructionText,
  type LoadedInstructionFile,
  loadedInstructionFiles,
  REPO_INSTRUCTIONS_TOTAL_MAX,
  repoInstructionTexts,
} from '../../prompts/repo-instructions'

const WORKSPACE = '/workspace'

const absolute = (path: string, cwd: string) =>
  posix.normalize(path.startsWith('/') ? path : posix.join(cwd, path))

/** The files a patch names (git headers or Codex's `*** … File:` lines). */
function patchFiles(patch: string): string[] {
  const out: string[] = []
  for (const line of patch.split('\n')) {
    const git = /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/.exec(line)
    const codex = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    const path = git?.[1] ?? codex?.[1]?.trim()
    if (path && path !== '/dev/null') out.push(path)
  }
  return out
}

/**
 * Folders whose repository instructions a tool call brings in: the folder of the file read or changed, the
 * folder searched, where a command or patch ran. `cwd` is where relative paths start (the session's folder,
 * else /workspace).
 */
export function touchedFolders(call: ToolCall, cwd: string): string[] {
  const a = (call.arguments ?? {}) as Record<string, unknown>
  const str = (key: string) => {
    const value = a[key]
    return typeof value === 'string' && value ? value : null
  }
  let folders: string[]
  switch (call.name) {
    case 'file_read':
    case 'file_edit':
    case 'file_write': {
      const path = str('path')
      folders = path ? [posix.dirname(absolute(path, cwd))] : []
      break
    }
    case 'grep':
    case 'glob':
      folders = [absolute(str('path') ?? cwd, cwd)]
      break
    case 'bash':
      folders = [absolute(str('cwd') ?? cwd, cwd)]
      break
    case 'apply_patch': {
      const base = absolute(str('cwd') ?? cwd, cwd)
      folders = [base, ...patchFiles(str('patch') ?? '').map((f) => posix.dirname(absolute(f, base)))]
      break
    }
    default:
      folders = []
  }
  return [...new Set(folders)].filter((f) => f === WORKSPACE || f.startsWith(`${WORKSPACE}/`))
}

const textsOf = (message: ChatMessage): string[] =>
  message.content.flatMap((p: ContentPart) => (p.type === 'text' ? [p.text] : []))

/** The instruction files already in a context (system, transcript, earlier tool results), by path. */
export function instructionFilesIn(messages: readonly ChatMessage[]): Map<string, LoadedInstructionFile> {
  const out = new Map<string, LoadedInstructionFile>()
  for (const message of messages)
    for (const text of textsOf(message))
      for (const file of loadedInstructionFiles(text)) out.set(file.path, file)
  return out
}

/** The instruction files of a native call's context, for its record. */
export function injectedInstructionFiles(messages: readonly ChatMessage[]): InstructionFileInfo[] {
  return [...instructionFilesIn(messages).values()].map((f) => ({ ...f, source: 'injected' as const }))
}

/**
 * The repository instructions of a native turn: what its tool calls bring into the context. What is already
 * there is read back from the context itself, so it lives as long as the text does (a chat turn, a session
 * transcript until it is compacted). Resolutions are kept for the turn.
 */
export class TurnInstructions {
  private readonly resolved = new Map<string, Promise<RepoInstructionFile[]>>()

  constructor(
    private readonly env: Pick<AgentEnvironment, 'repoInstructions' | 'log'>,
    private readonly bot: Bot,
    private readonly signal: AbortSignal,
  ) {}

  /** The instruction files of `folders`' repositories, root first ([] when they cannot be read). */
  files(folders: string[]): Promise<RepoInstructionFile[]> {
    if (folders.length === 0) return Promise.resolve([])
    const key = folders.join('\n')
    let found = this.resolved.get(key)
    if (!found) {
      found = this.env.repoInstructions(this.bot, folders, this.signal).catch((err: unknown) => {
        this.env.log('warn', 'repository instructions unavailable', {
          botId: this.bot.id,
          err: (err as Error).message,
        })
        return []
      })
      this.resolved.set(key, found)
    }
    return found
  }

  /**
   * A tool result as it enters the context: its output cut to size, the instruction files it carries kept
   * whole (minus those the context already has), then those of the folders the call touched that are new.
   */
  async toolContent(
    call: ToolCall,
    content: ContentPart[],
    options: { cwd: string; context: readonly ChatMessage[]; succeeded: boolean },
  ): Promise<ContentPart[]> {
    const carried = content.filter((p) => p.type === 'text' && isRepoInstructionText(p.text))
    const output = truncateToolContent(content.filter((p) => !carried.includes(p)))
    if (carried.length === 0 && !options.succeeded) return output
    const known = new Set(instructionFilesIn(options.context).keys())
    const kept = carried.filter((p) => {
      const [file] = p.type === 'text' ? loadedInstructionFiles(p.text) : []
      if (!file || known.has(file.path)) return false
      known.add(file.path)
      return true
    })
    const touched = options.succeeded ? await this.files(touchedFolders(call, options.cwd)) : []
    const fresh = touched.filter((f) => !known.has(f.path))
    const keptBytes = kept.reduce((n, p) => n + (p.type === 'text' ? Buffer.byteLength(p.text) : 0), 0)
    const added = repoInstructionTexts(fresh, Math.max(0, REPO_INSTRUCTIONS_TOTAL_MAX - keptBytes)).map(
      (text): ContentPart => ({ type: 'text', text }),
    )
    return [...output, ...kept, ...added]
  }
}
