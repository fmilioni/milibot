/**
 * The part of the `codex app-server` protocol (JSON-RPC 2.0 over stdio, one JSON object per line, no
 * `jsonrpc` field) Milibot uses, from the schema of `CODEX_VERSION` (`codex app-server generate-ts`).
 */

export type RequestId = number | string

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
  | { type: 'image'; url: string }

export type CodexErrorInfo =
  | 'contextWindowExceeded'
  | 'usageLimitExceeded'
  | 'rateLimitExceeded'
  | 'serverOverloaded'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'sandboxError'
  | 'other'
  | { httpConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamDisconnected: { httpStatusCode: number | null } }
  | { responseTooManyFailedAttempts: { httpStatusCode: number | null } }
  | { activeTurnNotSteerable: { turnKind: string } }
  | string

interface TurnError {
  message: string
  codexErrorInfo: CodexErrorInfo | null
  additionalDetails: string | null
}

type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface Turn {
  id: string
  status: TurnStatus
  error: TurnError | null
  durationMs: number | null
}

interface Thread {
  id: string
  path: string | null
  model: string | null
}

export interface ThreadStartResponse {
  thread: Thread
  model: string
}

export interface CommandAction {
  type: 'read' | 'listFiles' | 'search' | 'unknown' | string
  command?: string
  name?: string
  path?: string | null
  query?: string | null
}

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  /** `add`/`delete`: the file's content; `update`: unified hunks (`@@ … @@` lines, no file headers). */
  diff: string
}

export type ThreadItem =
  | { type: 'userMessage'; id: string; clientId?: string | null; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'plan'; id: string; text: string }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
      commandActions: CommandAction[]
      aggregatedOutput?: string | null
      exitCode?: number | null
      durationMs?: number | null
    }
  | {
      type: 'fileChange'
      id: string
      changes: FileUpdateChange[]
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: 'inProgress' | 'completed' | 'failed'
      arguments: unknown
      result?: { content: unknown[]; structuredContent?: unknown } | null
      error?: { message: string } | null
    }
  | { type: 'webSearch'; id: string; query: string }
  | { type: 'imageView'; id: string; path: string }
  | {
      type: 'imageGeneration'
      id: string
      status: string
      revisedPrompt: string | null
      result: string
      savedPath?: string
      failure: { type: 'usageLimitExceeded'; limitId: string; resetsAt: number | null } | null
    }
  | { type: 'contextCompaction'; id: string }
  | { type: string; id: string }

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  /** Unix seconds. */
  resetsAt: number | null
}

/** Sparse: a null window leaves the last known one as it was. */
export interface RateLimitSnapshot {
  limitId: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  planType: string | null
  rateLimitReachedType: string | null
}

export type ServerNotification =
  | { method: 'turn/started'; params: { threadId: string; turn: Turn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: Turn } }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: ThreadItem } }
  | {
      method: 'item/agentMessage/delta'
      params: { threadId: string; turnId: string; itemId: string; delta: string }
    }
  | {
      method: 'thread/tokenUsage/updated'
      params: {
        threadId: string
        turnId: string
        tokenUsage: {
          total: TokenUsageBreakdown
          last: TokenUsageBreakdown
          modelContextWindow: number | null
        }
      }
    }
  | { method: 'account/rateLimits/updated'; params: { rateLimits: RateLimitSnapshot } }
  | {
      method: 'error'
      params: { error: TurnError; willRetry: boolean; threadId: string; turnId: string }
    }
  | {
      method: 'mcpServer/startupStatus/updated'
      params: { threadId: string | null; name: string; status: string; error: string | null }
    }
  | { method: string; params?: unknown }

export interface ServerRequest {
  id: RequestId
  method: string
  params?: unknown
}
